import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { DateTime } from 'luxon';
import {
  And,
  FindOptionsWhere,
  ILike,
  In,
  IsNull,
  LessThan,
  MoreThan,
  MoreThanOrEqual,
  Not,
} from 'typeorm';
import { Transactional } from 'typeorm-transactional';

import { CreateTaskDto } from './dtos';
import {
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MAX_LIMIT,
} from './dtos/search-tasks.query';
import { EntityNotFoundException } from '@/exceptions/entity-not-found.exception';
import {
  Calendar,
  NotificationRule,
  RecurrenceEndType,
  Task,
  TaskGroup,
  TaskOccurrenceException,
} from '@/modules/database/entities';
import {
  CalendarDatabaseService,
  TaskDatabaseService,
  TaskGroupDatabaseService,
} from '@/modules/database/services';
import {
  NotificationRuleService,
  ReminderInput,
} from '@/modules/notification-rule/notification-rule.service';
import { CreateRecurrenceRuleDto } from '@/modules/recurrence-rule/dtos';
import {
  ProposedSeries,
  RecurrenceRuleService,
} from '@/modules/recurrence-rule/recurrence-rule.service';
import {
  Occurrence,
  RecurrenceConfig,
  RecurrenceSource,
} from '@/modules/recurrence-rule/recurrence.types';
import {
  type OccurrenceOverrideChanges,
  TaskOccurrenceExceptionService,
} from '@/modules/task-occurrence-exception/task-occurrence-exception.service';
import { SyncStateService } from '@/modules/sync/sync-state.service';
import { parseWallClockInZone } from '@/utils/datetime';

/**
 * Overlap lag applied to the delta cursor. TypeORM stamps `updatedAt` /
 * `deletedAt` when a statement executes inside a transaction, but the row only
 * becomes visible at COMMIT. A row can therefore commit AFTER a delta read yet
 * carry a timestamp earlier than that delta's `since`, making it invisible to
 * every future delta. Widening each delta's predicates to `since − 5s` closes
 * that in-flight-transaction race; the cost is that changes made within 5s of
 * the previous delta are re-reported once, which is harmless — the client apply
 * (upsert / delete / memo-invalidate) is idempotent. 5s comfortably exceeds any
 * transaction span here.
 */
const DELTA_OVERLAP_LAG_MS = 5000;

/**
 * Stable error codes surfaced in `BadRequestException` payloads for
 * override-related conflicts, so the client can react (resync + retry) rather
 * than show a generic failure.
 */
export const OCCURRENCE_NOT_GENERATED = 'OCCURRENCE_NOT_GENERATED';
export const OCCURRENCE_OVERRIDDEN = 'OCCURRENCE_OVERRIDDEN';

/**
 * Delete semantics for a task that is an override child:
 * - `remove` (default): the occurrence is gone — soft-delete the child AND write
 *   a skip on the parent slot, so a plain delete sticks for every caller.
 * - `revert`: drop the override and restore the generated occurrence, carrying
 *   back any completion the child had absorbed.
 */
export type TaskDeleteMode = 'remove' | 'revert';

/**
 * The patch a create-override request may carry. Every field is optional and
 * tri-state (undefined = inherit the parent snapshot; null = clear where
 * nullable), mirroring `UpdateTaskInput`. `startAt`/`endAt` are wall-clock ISO
 * strings interpreted in the parent's timezone.
 */
export interface CreateOverrideInput {
  title?: string;
  notes?: string | null;
  startAt?: string | null;
  endAt?: string | null;
  isAllDay?: boolean;
  timezone?: string;
  requiresCompletion?: boolean | null;
  color?: string | null;
  icon?: string | null;
  groupId?: string | null;
  reminders?: ReminderInput[];
}

/**
 * Fields the assistant may change on an existing event (the "all" / one-off
 * scope). `startAt`/`endAt`/`notes`/`groupId`/`requiresCompletion`/`color` accept
 * `null` to clear; an omitted key leaves the current value untouched.
 * `recurrence` set to a DTO adds or replaces the inline config; set to `null`
 * removes recurrence entirely. `isAllDay` and `timezone` are optional non-nullable
 * scalars (`timezone` is a non-null column, so it can only be RE-SET, never
 * cleared). Clearing `requiresCompletion` (null) drops the task's own value so the
 * group default (then `false`) applies via the effective-settings resolver.
 */
export interface UpdateTaskInput {
  title?: string;
  notes?: string | null;
  startAt?: string | null;
  endAt?: string | null;
  isAllDay?: boolean;
  timezone?: string;
  requiresCompletion?: boolean | null;
  color?: string | null;
  icon?: string | null;
  groupId?: string | null;
  recurrence?: CreateRecurrenceRuleDto | null;
  // When provided, REPLACES the full per-task reminder set (empty clears them);
  // omitted leaves the existing reminders intact.
  reminders?: ReminderInput[];
}

/**
 * Options narrowing an occurrence-aware range read. Defaults keep today's agenda
 * behaviour: completed instances and timeless todos are excluded.
 */
export interface FindOccurrencesOptions {
  calendarId?: string;
  groupId?: string;
  includeCompleted?: boolean;
  includeTodos?: boolean;
}

/**
 * Outcome of toggling a single occurrence's completion. `completedAt` is the
 * persisted value (the exception row's, or the master's when the task is not
 * recurring). `isOccurrenceScoped` is false when the change collapsed to a plain
 * master `setCompleted` (a non-recurring task), so callers can report
 * `occurrenceStart: null` to match reality.
 */
export interface OccurrenceCompletionResult {
  completedAt: Date | null;
  isOccurrenceScoped: boolean;
}

/**
 * Changes carried by a "this and following" split. Anchor-field keys retarget
 * the new series' first instance; `recurrence` is merged on top of the cloned
 * rule. `groupId` (when provided) is validated against the new master's calendar
 * and applied atomically in the same insert — never as a follow-up write.
 * `requiresCompletion`/`color`/`isAllDay`/`timezone` retarget the new series so a
 * `this_and_following` edit of those fields is not silently dropped; an omitted
 * key keeps the cloned anchor's value. All keys are optional — an empty object
 * splits the series at `originalStart` without otherwise altering it.
 */
export interface SplitSeriesChanges {
  title?: string;
  notes?: string | null;
  startAt?: string | null;
  endAt?: string | null;
  groupId?: string | null;
  requiresCompletion?: boolean | null;
  color?: string | null;
  isAllDay?: boolean;
  timezone?: string;
  recurrence?: CreateRecurrenceRuleDto;
}

/**
 * The set of existing-event clashes a PROPOSED recurring series would introduce,
 * found by expanding the proposal over the bounded look-ahead horizon and
 * overlap-checking each generated occurrence (Story 9). `conflictDates` lists the
 * distinct occurrence start dates that clash (so the assistant can say "overlaps
 * on N date(s)"); `conflictingTasks` is the de-duplicated set of existing tasks
 * clashed against. An empty `conflictDates` means the series is clear within the
 * horizon and may commit as a normal recurring create/edit.
 */
export interface RecurringSeriesConflicts {
  conflictDates: Date[];
  conflictingTasks: Task[];
}

/**
 * The proposed change to an existing recurring series, for the write-side edit
 * conflict check (Story 9). Each field, when provided, retargets the effective
 * series the check expands; omitted fields keep the task's current value.
 * `recurrence` set to a DTO replaces the rule grammar; omitted keeps the current
 * rule. The check only runs (and can only clash) for a TIMED effective series.
 */
export interface RecurringEditProposal {
  startAt?: string;
  endAt?: string;
  title?: string;
  recurrence?: CreateRecurrenceRuleDto;
  // The zone a bare wall-clock move is interpreted in AND the series is expanded
  // in — the dispatcher passes the resolved user zone so the conflict window
  // matches the instant the subsequent write persists. Omitted ⇒ task.timezone.
  timezone?: string;
}

/**
 * Options narrowing a change-detection (delta) read.
 */
export interface FindChangedOptions {
  includeTodos?: boolean;
}

/**
 * The precise delta returned by `findChangedSince`. `tasks` are the changed
 * series rows (recurrence is the inline `recurrenceConfig` on each row — no
 * relation to hydrate), `deleted` the soft-deleted series ids, `exceptions` the
 * changed per-occurrence overrides, and `serverTime` the opaque cursor the client
 * echoes on its next call. On the first call (no `since`), the service returns
 * empty arrays and only the cursor, letting the client fall back to a full
 * per-window SWR sync.
 */
export interface ChangedSince {
  tasks: Task[];
  deleted: string[];
  exceptions: TaskOccurrenceException[];
  serverTime: Date;
}

/**
 * Service handling Task CRUD, completion, recurrence-aware reads, and the three
 * recurring-edit scopes (this occurrence / this-and-following / all).
 */
@Injectable()
export class TaskService {
  constructor(
    private readonly taskDatabaseService: TaskDatabaseService,
    private readonly calendarDatabaseService: CalendarDatabaseService,
    private readonly taskGroupDatabaseService: TaskGroupDatabaseService,
    private readonly recurrenceRuleService: RecurrenceRuleService,
    private readonly taskOccurrenceExceptionService: TaskOccurrenceExceptionService,
    private readonly notificationRuleService: NotificationRuleService,
    private readonly syncStateService: SyncStateService,
  ) {}

  /**
   * Creates a new Task inside the Calendar identified by `dto.calendarId`.
   * Supports timed/all-day events, todos (null `startAt`/`endAt`), an optional
   * `groupId` (which must live in the same calendar), and an optional
   * `recurrence` rule — persisted inline as a single `recurrenceConfig` JSONB
   * value on the row, never as N materialized rows (ADR 0054).
   * `requiresCompletion` / `color` are stored as-is (nullable); when null the
   * effective-settings resolver applies group inheritance + the hard default.
   * Throws 404 when the calendar is missing, 403 when it belongs to another user,
   * and 400 when `endAt` precedes `startAt`, the group is in another calendar, or
   * a recurrence is requested without an anchor `startAt`.
   *
   * Transactional so the task row and its per-task reminder rows commit or roll
   * back together — a reminder-write failure must not leave a persisted task whose
   * 201 response never reflected those reminders.
   */
  @Transactional()
  async create(userId: string, dto: CreateTaskDto): Promise<Task> {
    await this.ensureCalendarOwnedByUser(dto.calendarId, userId);

    // Naive wall-clock ISO from the assistant is a local time in `dto.timezone`
    // (the dispatcher-resolved user zone); an explicit in-string offset is kept.
    const startAt = dto.startAt
      ? parseWallClockInZone(dto.startAt, dto.timezone)
      : null;
    const endAt = dto.endAt
      ? parseWallClockInZone(dto.endAt, dto.timezone)
      : null;

    if (startAt && endAt && endAt.getTime() < startAt.getTime()) {
      throw new BadRequestException(
        'endAt must be greater than or equal to startAt',
      );
    }

    if (dto.recurrence && !startAt) {
      throw new BadRequestException(
        'a recurring task requires an anchor startAt',
      );
    }

    if (dto.groupId) {
      await this.ensureGroupInCalendar(dto.groupId, dto.calendarId);
    }

    const recurrenceConfig = dto.recurrence
      ? RecurrenceRuleService.toConfig(dto.recurrence)
      : null;

    const task = this.taskDatabaseService.createInstance({
      calendarId: dto.calendarId,
      groupId: dto.groupId ?? null,
      title: dto.title,
      notes: dto.notes ?? null,
      startAt,
      endAt,
      isAllDay: dto.isAllDay ?? false,
      timezone: dto.timezone,
      requiresCompletion: dto.requiresCompletion ?? null,
      color: dto.color ?? null,
      icon: dto.icon ?? null,
      recurrenceConfig,
    });

    const savedTask = await this.taskDatabaseService.save(task);

    // Persist any per-task reminders as taskId-linked notification rules (S1).
    if (dto.reminders && dto.reminders.length > 0) {
      await this.notificationRuleService.createForTask(
        savedTask.id,
        dto.reminders,
      );
    }

    await this.syncStateService.bump(userId);

    return savedTask;
  }

  /**
   * Searches the authed user's tasks (across every calendar they own, or a
   * single explicit `calendarId`-less group) by a case-insensitive `ILIKE` over
   * `title` + `notes` (M1). NOT window-bound — recurring series match on their
   * anchor row, not per-occurrence. An optional `groupId` narrows the scope; the
   * `group` relation is loaded so each hit carries the owning group's color. The
   * result is capped at `limit` (defaulted + clamped), ordered by `startAt`
   * descending (most recent first), nulls last.
   *
   * An empty/whitespace-only term returns no matches (a blank search is treated
   * as "nothing to find" rather than "everything").
   */
  async searchTasks(
    userId: string,
    term: string,
    opts: { groupId?: string; limit?: number } = {},
  ): Promise<Task[]> {
    const trimmed = term.trim();

    if (trimmed.length === 0) return [];

    const calendarIds = await this.resolveCalendarScope(userId, undefined);

    if (calendarIds.length === 0) return [];

    const take = Math.min(opts.limit ?? SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT);

    // Escape ILIKE wildcards in the user term so `%` / `_` are literal.
    const pattern = `%${this.escapeLike(trimmed)}%`;
    const calendarScope = In(calendarIds);
    const groupScope = opts.groupId ? { groupId: opts.groupId } : {};

    // An array `where` is OR-ed: a row matches when title OR notes contains the
    // term. Each branch repeats the calendar + group scope so the OR cannot
    // widen past the user's own (optionally group-narrowed) tasks.
    const base: FindOptionsWhere<Task> = {
      calendarId: calendarScope,
      ...groupScope,
    };
    const where: FindOptionsWhere<Task>[] = [
      { ...base, title: ILike(pattern) },
      { ...base, notes: ILike(pattern) },
    ];

    return this.taskDatabaseService.findAll({
      where,
      relations: { group: true },
      order: { startAt: 'DESC' },
      take,
    });
  }

  /**
   * Returns the per-task reminder rules for a task the user owns (S1). Validates
   * ownership first, then delegates to the notification-rule service. Surfaced so
   * the controller can hydrate `TaskDTO.reminders` after a create / update / get.
   */
  async listReminders(
    userId: string,
    taskId: string,
  ): Promise<NotificationRule[]> {
    await this.findById(userId, taskId);

    return this.notificationRuleService.listByTask(taskId);
  }

  /**
   * Lists Tasks in the given Calendar whose `startAt` falls in the half-open
   * window `[from, to)`, ordered by `startAt` ascending. Returns raw rows and
   * does NOT expand recurrence — `findOccurrencesInRange` is the occurrence-aware
   * read. Retained for existing callers.
   * Throws 404 when the calendar does not exist, 403 when it belongs to another
   * user, and 400 when the window is empty.
   */
  async findInRange(
    userId: string,
    calendarId: string,
    from: Date,
    to: Date,
  ): Promise<Task[]> {
    if (from.getTime() >= to.getTime()) {
      throw new BadRequestException('`to` must be greater than `from`');
    }

    await this.ensureCalendarOwnedByUser(calendarId, userId);

    return this.taskDatabaseService.findAll({
      where: {
        calendarId,
        startAt: And(MoreThanOrEqual(from), LessThan(to)),
      },
      order: { startAt: 'ASC' },
    });
  }

  /**
   * Computes the precise change-delta for a calendar since the opaque cursor
   * `since`: the changed series rows (with their recurrence rule hydrated), the
   * ids of series soft-deleted after `since` (visible via `.withDeleted()`),
   * and the per-occurrence overrides changed after `since`. `serverTime` is the
   * server-clock instant captured BEFORE the reads, returned as the cursor the
   * client echoes next time — using the server clock (not the client's) avoids
   * skew, and capturing it first guarantees no change is missed between the
   * reads and the stamp (at worst a change is re-reported, which is idempotent).
   *
   * On the first call `since` is null: the client has no cursor yet, so there is
   * nothing to diff against — return empty sets and just hand back `serverTime`
   * for the client to store, letting the normal full per-window SWR sync cover
   * the initial load.
   *
   * Scoped to a single calendar the user owns (404/403 on miss). `includeTodos`
   * defaults to true so timeless todos are diffed alongside timed tasks.
   */
  async findChangedSince(
    userId: string,
    since: Date | null,
    calendarId: string,
    opts: FindChangedOptions = {},
  ): Promise<ChangedSince> {
    await this.ensureCalendarOwnedByUser(calendarId, userId);

    // Capture the cursor before any read so a write landing mid-read is at worst
    // re-reported on the next delta, never skipped.
    const serverTime = new Date();

    if (since === null) {
      return { tasks: [], deleted: [], exceptions: [], serverTime };
    }

    const includeTodos = opts.includeTodos ?? true;

    // Widen the cursor by the overlap lag to catch rows that committed after the
    // previous delta with an earlier timestamp (in-flight-transaction race).
    // `serverTime` above is returned unchanged — only the read predicates lag.
    const effectiveSince = new Date(since.getTime() - DELTA_OVERLAP_LAG_MS);

    const changedTasks = await this.taskDatabaseService.findAll({
      where: {
        calendarId,
        updatedAt: MoreThan(effectiveSince),
        ...(includeTodos ? {} : { startAt: Not(IsNull()) }),
      },
      order: { updatedAt: 'ASC' },
    });

    // `.withDeleted()` is required for soft-deleted rows to be visible at all;
    // we then keep only those whose tombstone (`deletedAt`) landed after the
    // (lagged) cursor so the client can drop exactly the newly-removed series.
    const deletedRows = await this.taskDatabaseService.findAll({
      where: {
        calendarId,
        deletedAt: MoreThan(effectiveSince),
      },
      withDeleted: true,
    });
    const deleted = deletedRows.map((task) => task.id);

    // Exceptions are keyed by taskId, not calendarId, so scope the changed-
    // exception read to this calendar's (non-deleted) series ids.
    const seriesRows = await this.taskDatabaseService.findAll({
      where: { calendarId },
      select: { id: true },
    });
    const exceptions =
      await this.taskOccurrenceExceptionService.findChangedForTasks(
        seriesRows.map((task) => task.id),
        effectiveSince,
      );

    return { tasks: changedTasks, deleted, exceptions, serverTime };
  }

  /**
   * Returns the merged, time-sorted stream of occurrences intersecting the
   * half-open window `[from, to)` for the calendars the user owns: one-off tasks
   * wrapped as single occurrences, plus every recurring anchor expanded via
   * `RecurrenceRuleService.expandOccurrences`. Each recurring anchor's config is
   * read inline off the row (or inherited from its group) and its exceptions
   * through `TaskOccurrenceExceptionService.findForTask`. Completed instances are dropped
   * unless `includeCompleted`; timeless todos surface only when `includeTodos`.
   * Throws 404/403 when an explicit `calendarId` is missing or not owned, and 400
   * when the window is empty.
   */
  async findOccurrencesInRange(
    userId: string,
    from: Date,
    to: Date,
    opts: FindOccurrencesOptions = {},
  ): Promise<Occurrence[]> {
    if (from.getTime() >= to.getTime()) {
      throw new BadRequestException('`to` must be greater than `from`');
    }

    const calendarIds = await this.resolveCalendarScope(
      userId,
      opts.calendarId,
    );

    if (calendarIds.length === 0) return [];

    const oneOffOccurrences = await this.readOneOffOccurrences(
      calendarIds,
      from,
      to,
      opts,
    );
    const recurringOccurrences = await this.readRecurringOccurrences(
      calendarIds,
      from,
      to,
      opts.groupId,
    );

    // Suppress every generated occurrence whose (parentId, originalStart) slot is
    // replaced by a live override child (the child itself surfaces via the
    // one-off read). Keyed on the child's originalStartAt — NOT its (possibly
    // moved) startAt — so a slot is hidden in its ORIGINAL month regardless of
    // where the override moved the event to. Also covers the "former parent"
    // case: a task whose rule was cleared becomes a one-off wrapped at its
    // startAt, which this suppresses when a child pins its anchor slot.
    const suppressedSlots = await this.buildOverrideSuppressionSet(
      calendarIds,
      from,
      to,
    );

    const merged = [...oneOffOccurrences, ...recurringOccurrences].filter(
      (occurrence) => {
        if (
          occurrence.originalStart &&
          suppressedSlots.has(
            this.overrideSlotKey(
              occurrence.task.id,
              occurrence.originalStart,
            ),
          )
        ) {
          return false;
        }

        return opts.includeCompleted || occurrence.completedAt === null;
      },
    );

    return merged.sort(
      (left, right) =>
        this.startSortKey(left.occurrenceStart) -
        this.startSortKey(right.occurrenceStart),
    );
  }

  /**
   * Builds the set of `${parentTaskId}#${originalStartMs}` slot keys covered by a
   * LIVE override child whose original slot falls in `[from, to)`, across the
   * given calendars. A generated occurrence (or a former-parent one-off) matching
   * a key is suppressed so only the materialized child renders for that slot.
   *
   * Scoped by calendar (not group): a child moved out of its parent's group must
   * still suppress the parent's slot in a group-scoped view. Keying on
   * `originalStartAt` (not the child's own `startAt`) hides the slot in its
   * original month even after the override moves the event elsewhere.
   */
  private async buildOverrideSuppressionSet(
    calendarIds: string[],
    from: Date,
    to: Date,
  ): Promise<Set<string>> {
    const children = await this.taskDatabaseService.findAll({
      where: {
        calendarId: In(calendarIds),
        parentTaskId: Not(IsNull()),
        originalStartAt: And(MoreThanOrEqual(from), LessThan(to)),
      },
      select: { parentTaskId: true, originalStartAt: true },
    });

    const keys = new Set<string>();

    for (const child of children) {
      // The query already restricts to non-null parentTaskId / in-window
      // originalStartAt; guard defensively against a partial row lacking either.
      if (!child.parentTaskId || !child.originalStartAt) continue;

      keys.add(this.overrideSlotKey(child.parentTaskId, child.originalStartAt));
    }

    return keys;
  }

  /**
   * Stable slot key for override suppression: the parent task id plus the
   * epoch-ms of the original (pre-override) occurrence instant.
   */
  private overrideSlotKey(parentTaskId: string, originalStart: Date): string {
    return `${parentTaskId}#${originalStart.getTime()}`;
  }

  /**
   * Returns per-day occurrence counts over the half-open window `[from, to)` for
   * the given calendar. Reuses `findOccurrencesInRange` for expansion (recurrence
   * rules expanded, exceptions applied, DST-correct) and buckets each occurrence
   * onto its local date (`YYYY-MM-DD`) in the task's timezone. Counts on the same
   * local date are summed; zero-count days are absent from the result. Completed
   * occurrences are filtered before bucketing per `includeCompleted`. Throws 404/403
   * when the calendar is missing or owned by another user, 400 on an empty window
   * (all delegated to `findOccurrencesInRange`).
   */
  async getDailyCounts(
    userId: string,
    from: Date,
    to: Date,
    opts: { calendarId?: string; includeCompleted?: boolean } = {},
  ): Promise<Record<string, number>> {
    const occurrences = await this.findOccurrencesInRange(userId, from, to, {
      calendarId: opts.calendarId,
      includeCompleted: opts.includeCompleted,
    });

    const counts: Record<string, number> = {};

    for (const occurrence of occurrences) {
      // Timeless todos (null start) are not surfaced here — includeTodos stays
      // off — but guard anyway so a null never buckets onto a bogus date.
      if (occurrence.occurrenceStart === null) continue;

      const localDate = DateTime.fromJSDate(occurrence.occurrenceStart, {
        zone: occurrence.task.timezone,
      }).toISODate() as string;

      counts[localDate] = (counts[localDate] ?? 0) + 1;
    }

    return counts;
  }

  /**
   * Toggles the Task's completion state by id (series-master or one-off).
   * When `isCompleted` is true, stamps `completedAt = new Date()` only if
   * not already set (idempotent). When false, clears `completedAt`.
   * Asserts calendar ownership (404 when missing, 403 when owned by another
   * user) so callers no longer need a compensating pre-check. Bumps the user's
   * sync revision only when the completion state actually changed.
   *
   * Transactional so the completion write and the revision bump commit as a unit.
   */
  @Transactional()
  async setCompleted(
    userId: string,
    id: string,
    isCompleted: boolean,
  ): Promise<Task> {
    const task = await this.findById(userId, id);

    if (isCompleted) {
      if (task.completedAt) {
        return task;
      }

      task.completedAt = new Date();

      const saved = await this.taskDatabaseService.save(task);

      await this.syncStateService.bump(userId);

      return saved;
    }

    if (task.completedAt === null) {
      return task;
    }

    task.completedAt = null;

    const saved = await this.taskDatabaseService.save(task);

    await this.syncStateService.bump(userId);

    return saved;
  }

  /**
   * Marks a single recurring occurrence complete or not, via a
   * `TaskOccurrenceException` keyed by `(taskId, originalStart)`. For a
   * non-recurring task the scope collapses to a plain master `setCompleted`.
   * Validates ownership first. Returns the persisted `completedAt` plus whether
   * the change was occurrence-scoped (false when it collapsed to the master) so
   * callers can surface the real stored timestamp rather than fabricating one.
   *
   * Deliberately stays lenient on `originalStart` membership (no rule-expansion
   * guard like `applyOccurrenceOverride`): the spec treats a completion-only
   * change as no-op-safe, and adding the guard would cost an extra anchor read +
   * expansion on every per-instance completion for no correctness benefit (a
   * completion on a phantom coordinate is harmless and never surfaces in a read).
   */
  @Transactional()
  async setOccurrenceCompleted(
    userId: string,
    taskId: string,
    originalStart: Date,
    completed: boolean,
  ): Promise<OccurrenceCompletionResult> {
    const task = await this.findById(userId, taskId);

    if (task.recurrenceConfig === null) {
      const updated = await this.setCompleted(userId, taskId, completed);

      return { completedAt: updated.completedAt, isOccurrenceScoped: false };
    }

    // If a live override child occupies this slot, the occurrence's truth lives
    // on the child — redirect the completion there. A completion written to the
    // suppressed slot's exception would never surface (and could zombie-complete
    // a later regenerated slot). Old clients need no change: they still PATCH the
    // parent, the server routes it to the child.
    const child = await this.taskDatabaseService.findOneBy({
      parentTaskId: taskId,
      originalStartAt: originalStart,
    });

    if (child) {
      const updated = await this.setCompleted(userId, child.id, completed);

      return { completedAt: updated.completedAt, isOccurrenceScoped: true };
    }

    const exception = await this.taskOccurrenceExceptionService.upsertOverride(
      taskId,
      originalStart,
      { completedAt: completed ? new Date() : null },
    );

    await this.syncStateService.bump(userId);

    return { completedAt: exception.completedAt, isOccurrenceScoped: true };
  }

  /**
   * Applies a single-occurrence override (the "this occurrence" scope) by
   * upserting a `TaskOccurrenceException`. Delete-one is `{ isSkipped: true }`.
   * For a non-recurring task the scope collapses to a plain single-row update
   * (or soft-delete when `isSkipped`). Validates ownership first.
   *
   * When the change actually mutates the instance (any of `overrideStartAt` /
   * `overrideEndAt` / `overrideTitle`), `originalStart` must be a real generated
   * occurrence of the series — otherwise the upsert would persist a phantom inert
   * row keyed at a coordinate the rule never produces. A pure skip or
   * completion-only change stays lenient (it is no-op-safe either way), per the
   * spec error table.
   */
  @Transactional()
  async applyOccurrenceOverride(
    userId: string,
    taskId: string,
    originalStart: Date,
    changes: OccurrenceOverrideChanges,
  ): Promise<void> {
    const task = await this.findById(userId, taskId);

    if (task.recurrenceConfig === null) {
      // The collapse delegates to update / remove / setCompleted, each of which
      // bumps the revision itself — no bump here.
      await this.collapseOverrideToMaster(userId, taskId, changes);

      return;
    }

    // A live override child already owns this slot: the exception-based skip /
    // override path would desync from the materialized child. The client should
    // delete the child instead (which writes the skip). 409 so it can react.
    const child = await this.taskDatabaseService.findOneBy({
      parentTaskId: taskId,
      originalStartAt: originalStart,
    });

    if (child) {
      throw new ConflictException({
        code: OCCURRENCE_OVERRIDDEN,
        message:
          'this occurrence has a materialized override; edit or delete it directly',
      });
    }

    if (this.isOverrideMutation(changes)) {
      this.ensureGeneratedOccurrence(task, originalStart);
    }

    await this.taskOccurrenceExceptionService.upsertOverride(
      taskId,
      originalStart,
      changes,
    );

    await this.syncStateService.bump(userId);
  }

  /**
   * Creates — or updates, when one already exists — a materialized OVERRIDE child
   * for a single occurrence of the recurring parent `parentId` at `originalStart`.
   * The child is a first-class one-off task linked by `(parentTaskId,
   * originalStartAt)` that suppresses the generated occurrence and can then be
   * edited / moved / completed independently while staying connected to the
   * series.
   *
   * Locks the parent row FOR UPDATE so this check-then-insert serializes against
   * a concurrent rule edit's detach sweep. On a first override it validates the
   * slot is generated by the parent's EFFECTIVE rule, snapshots the parent,
   * absorbs any pre-existing `TaskOccurrenceException` (span / title /
   * completion), copies the parent's reminders, then applies the request patch.
   * Touches the parent so the affected windows invalidate on clients. Returns the
   * child task.
   */
  @Transactional()
  async createOrUpdateOverride(
    userId: string,
    parentId: string,
    originalStart: Date,
    patch: CreateOverrideInput,
  ): Promise<Task> {
    // Lock the parent row alone — a FOR UPDATE spanning the nullable `group`
    // outer join errors on Postgres, so load no relations here and resolve the
    // effective config separately.
    const parent = await this.taskDatabaseService.findOne({
      where: { id: parentId },
      lock: { mode: 'pessimistic_write' },
    });

    if (!parent) {
      throw new EntityNotFoundException(Task);
    }

    await this.ensureCalendarOwnedByUser(parent.calendarId, userId);

    if (parent.parentTaskId != null) {
      throw new BadRequestException(
        'cannot create an override of an override occurrence',
      );
    }

    const existingChild = await this.taskDatabaseService.findOneBy({
      parentTaskId: parentId,
      originalStartAt: originalStart,
    });

    let child = existingChild;

    if (!child) {
      // First override for this slot: the coordinate must be a generated
      // occurrence of the EFFECTIVE (own ?? group) rule.
      const effectiveConfig = await this.resolveEffectiveConfigForTask(parent);

      this.ensureGeneratedOccurrenceEffective(
        parent,
        effectiveConfig,
        originalStart,
      );

      const durationMillis =
        parent.startAt && parent.endAt
          ? parent.endAt.getTime() - parent.startAt.getTime()
          : null;
      const snapshotEnd =
        durationMillis !== null
          ? new Date(originalStart.getTime() + durationMillis)
          : null;

      const created = this.taskDatabaseService.createInstance({
        calendarId: parent.calendarId,
        groupId: parent.groupId,
        title: parent.title,
        notes: parent.notes,
        startAt: originalStart,
        endAt: snapshotEnd,
        isAllDay: parent.isAllDay,
        timezone: parent.timezone,
        requiresCompletion: parent.requiresCompletion,
        color: parent.color,
        icon: parent.icon,
        notificationStrategyId: parent.notificationStrategyId,
        completedAt: null,
        recurrenceConfig: null,
        parentTaskId: parent.id,
        originalStartAt: originalStart,
      });

      child = await this.taskDatabaseService.save(created);

      // Copy the parent's per-task reminders (start-relative offsets → verbatim).
      const parentReminders = await this.notificationRuleService.listByTask(
        parent.id,
      );

      if (parentReminders.length > 0) {
        await this.notificationRuleService.createForTask(
          child.id,
          parentReminders.map((rule) => ({
            offsetMinutes: rule.offsetMinutes,
            channel: rule.channel,
          })),
        );
      }
    }

    // Absorb any pre-existing exception (span / title / completion) onto the
    // child and delete it — suppression is henceforth carried by the child. Runs
    // on both the create and upsert branches (the latter catches a late exception
    // written between an earlier create and this call).
    await this.absorbExceptionInto(child, parent, originalStart);

    // The parent is otherwise untouched by a child write; touch it so the
    // affected months invalidate on clients (the suppressed slot changed).
    await this.taskDatabaseService.touchUpdatedAt(parent.id);

    // Apply the request patch via the normal update path (validation, tri-state,
    // reminder replace, revision bump). A child never recurs, so no sweep fires.
    const updated = await this.update(userId, child.id, patch);

    await this.syncStateService.bump(userId);

    return updated;
  }

  /**
   * Folds any pre-existing `TaskOccurrenceException` at `(parent.id,
   * originalStart)` onto the override child (its overridden span / title /
   * completion), then hard-deletes the exception. No-op when none exists.
   */
  private async absorbExceptionInto(
    child: Task,
    parent: Task,
    originalStart: Date,
  ): Promise<void> {
    const exception = await this.taskOccurrenceExceptionService.findOverride(
      parent.id,
      originalStart,
    );

    if (!exception) return;

    const durationMillis =
      parent.startAt && parent.endAt
        ? parent.endAt.getTime() - parent.startAt.getTime()
        : null;

    if (exception.overrideStartAt) {
      child.startAt = exception.overrideStartAt;
      // overrideEndAt is independent of overrideStartAt: honor a prior length
      // change, else re-derive from the parent duration off the new start.
      child.endAt =
        exception.overrideEndAt ??
        (durationMillis !== null
          ? new Date(exception.overrideStartAt.getTime() + durationMillis)
          : child.endAt);
    } else if (exception.overrideEndAt) {
      child.endAt = exception.overrideEndAt;
    }

    if (exception.overrideTitle != null) {
      child.title = exception.overrideTitle;
    }

    if (exception.completedAt != null) {
      child.completedAt = exception.completedAt;
    }

    await this.taskDatabaseService.save(child);
    await this.taskOccurrenceExceptionService.deleteForSlot(
      parent.id,
      originalStart,
    );
  }

  /**
   * Returns the existing per-occurrence override row for `(taskId,
   * originalStart)`, or null when the occurrence has never been overridden.
   * Validates ownership first. The assistant's `this`-scope move gate reads this
   * to recover the occurrence's CURRENT span (a prior length change) so a
   * start-only move is conflict-checked — and persisted — against the true span
   * rather than the master duration.
   */
  async findOccurrenceException(
    userId: string,
    taskId: string,
    originalStart: Date,
  ): Promise<TaskOccurrenceException | null> {
    await this.findById(userId, taskId);

    return this.taskOccurrenceExceptionService.findOverride(
      taskId,
      originalStart,
    );
  }

  /**
   * Returns the LIVE materialized override child for `(parentId, originalStart)`,
   * or null when the occurrence has not been overridden. Asserts ownership of the
   * parent first. Lets the assistant's delete-`this` path route to the child's
   * own delete (skip + soft-delete) instead of the now-409 exception skip.
   */
  async findOverrideChild(
    userId: string,
    parentId: string,
    originalStart: Date,
  ): Promise<Task | null> {
    await this.findById(userId, parentId);

    return this.taskDatabaseService.findOneBy({
      parentTaskId: parentId,
      originalStartAt: originalStart,
    });
  }

  /**
   * Loads a single Task by id and asserts the given user owns its calendar.
   * Throws 404 when the task does not exist (or is soft-deleted), 403 when the
   * task belongs to another user's calendar.
   */
  async findById(userId: string, taskId: string): Promise<Task> {
    const task = await this.taskDatabaseService.findOneBy({ id: taskId });

    if (!task) {
      throw new EntityNotFoundException(Task);
    }

    await this.ensureCalendarOwnedByUser(task.calendarId, userId);

    return task;
  }

  /**
   * Loads a single Task by id WITH its `group` relation hydrated and asserts
   * ownership. Recurrence now lives inline on the row (`recurrenceConfig`), so a
   * plain `findById` already carries it; this variant additionally loads the
   * group so callers that resolve effective (group-inherited) settings have it.
   * Retained as a distinct entry point for the series-split / edit-conflict paths.
   * Throws 404 when the task is missing, 403 when owned by another user.
   */
  async findByIdWithRule(userId: string, taskId: string): Promise<Task> {
    const task = await this.taskDatabaseService.findOne({
      where: { id: taskId },
      relations: { group: true },
    });

    if (!task) {
      throw new EntityNotFoundException(Task);
    }

    await this.ensureCalendarOwnedByUser(task.calendarId, userId);

    return task;
  }

  /**
   * Updates an existing Task in the "all" / one-off scope: title, notes, time
   * window, all-day flag, completion requirement, group, and the master
   * recurrence rule (add / replace / remove). Validates ownership, group
   * co-location, and `endAt >= startAt`, and short-circuits when nothing changed.
   * Pre-existing occurrence exceptions are preserved (they remain keyed by their
   * `originalStart`). Returns the (possibly unchanged) Task.
   *
   * Transactional so the reminder replace (DELETE-all-then-reinsert via
   * `replaceForTask`) and the task-row save commit or roll back as a unit — a
   * reminder insert failing mid-replace must never leave the old reminders deleted
   * and the new set only partially written.
   */
  @Transactional()
  async update(
    userId: string,
    taskId: string,
    input: UpdateTaskInput,
  ): Promise<Task> {
    const task = await this.findById(userId, taskId);

    // Invariant: an override child is a one-off and can never carry its own
    // recurrence rule (it would then both expand AND suppress a slot).
    if (task.parentTaskId != null && input.recurrence != null) {
      throw new BadRequestException(
        'an override occurrence cannot have its own recurrence rule',
      );
    }

    // The zone a bare move is interpreted in = the task's NEXT timezone. The
    // dispatcher forwards the user's timezone as `input.timezone` on updates, so
    // this is the user zone, and `task.timezone` is re-set to it below.
    const nextTimezone = input.timezone ?? task.timezone;
    const nextStartAt = this.resolveNextDate(
      input.startAt,
      task.startAt,
      nextTimezone,
    );
    const nextEndAt = this.resolveNextDate(
      input.endAt,
      task.endAt,
      nextTimezone,
    );

    if (
      nextStartAt &&
      nextEndAt &&
      nextEndAt.getTime() < nextStartAt.getTime()
    ) {
      throw new BadRequestException(
        'endAt must be greater than or equal to startAt',
      );
    }

    const nextTitle = input.title ?? task.title;
    const nextNotes = input.notes !== undefined ? input.notes : task.notes;
    const nextGroupId =
      input.groupId !== undefined ? input.groupId : task.groupId;
    const nextIsAllDay = input.isAllDay ?? task.isAllDay;
    // requiresCompletion / color are nullable: an explicit value (incl. null to
    // clear) is taken, an omitted key keeps the current value.
    const nextRequiresCompletion =
      input.requiresCompletion !== undefined
        ? input.requiresCompletion
        : task.requiresCompletion;
    const nextColor = input.color !== undefined ? input.color : task.color;
    const nextIcon = input.icon !== undefined ? input.icon : task.icon;

    if (
      input.groupId !== undefined &&
      input.groupId !== null &&
      input.groupId !== task.groupId
    ) {
      await this.ensureGroupInCalendar(input.groupId, task.calendarId);
    }

    const recurrenceChanged = this.applyRecurrenceUpdate(task, input);

    // Reminders are replaced as their own write (a side relation, not a column);
    // do it after ownership is established but independent of the column diff so
    // a reminder-only edit still takes effect.
    if (input.reminders !== undefined) {
      await this.notificationRuleService.replaceForTask(
        task.id,
        input.reminders,
      );
    }

    // Capture the rule-INPUT diffs BEFORE mutating the row: recurrence, anchor
    // start, timezone, all-day, and group each change which occurrences a series
    // generates, so they drive the detach sweep + recurrenceUpdatedAt bump below.
    const startChanged = nextStartAt?.getTime() !== task.startAt?.getTime();
    const timezoneChanged = nextTimezone !== task.timezone;
    const isAllDayChanged = nextIsAllDay !== task.isAllDay;
    const groupChanged = nextGroupId !== task.groupId;

    const hasFieldChanges =
      nextTitle !== task.title ||
      nextNotes !== task.notes ||
      groupChanged ||
      isAllDayChanged ||
      timezoneChanged ||
      nextRequiresCompletion !== task.requiresCompletion ||
      nextColor !== task.color ||
      nextIcon !== task.icon ||
      startChanged ||
      nextEndAt?.getTime() !== task.endAt?.getTime();

    const remindersChanged = input.reminders !== undefined;

    // A child never recurs, so its own edits never rekey a series — only a real
    // (parentless) series' rule inputs trigger the sweep + discriminator bump.
    const ruleInputsChanged =
      task.parentTaskId == null &&
      (recurrenceChanged ||
        startChanged ||
        timezoneChanged ||
        isAllDayChanged ||
        groupChanged);

    if (hasFieldChanges) {
      task.title = nextTitle;
      task.notes = nextNotes;
      task.groupId = nextGroupId;
      task.isAllDay = nextIsAllDay;
      task.timezone = nextTimezone;
      task.requiresCompletion = nextRequiresCompletion;
      task.color = nextColor;
      task.icon = nextIcon;
      task.startAt = nextStartAt;
      task.endAt = nextEndAt;
    }

    if (ruleInputsChanged) {
      task.recurrenceUpdatedAt = new Date();
    }

    const needsSave = hasFieldChanges || recurrenceChanged || ruleInputsChanged;

    if (needsSave) {
      await this.taskDatabaseService.save(task);
      await this.syncStateService.bump(userId);
    } else if (remindersChanged) {
      // Reminder-only edit: no column/recurrence diff, but `replaceForTask`
      // already rewrote the reminder rows. Touch `updatedAt` so the change
      // surfaces in the delta endpoint's `Task.updatedAt > since` query (which
      // it otherwise would not — reminders are a side relation), and bump.
      await this.taskDatabaseService.touchUpdatedAt(task.id);
      await this.syncStateService.bump(userId);
    }

    // Re-evaluate override children against the parent's NEW effective rule:
    // detach those whose original slot is no longer generated, re-attach those a
    // rule revert regenerates.
    if (ruleInputsChanged) {
      const effectiveConfig = await this.resolveEffectiveConfigForTask(task);

      await this.sweepOverrideChildren(task, effectiveConfig);
    }

    return task;
  }

  /**
   * Splits a series at `originalStart` (the "this and following" scope): ends the
   * existing inline config the day before `originalStart`, then creates a new
   * `Task` with its own inline `recurrenceConfig` (the old config cloned with
   * `changes.recurrence` merged) anchored at `originalStart`. Exceptions dated
   * `>= originalStart` are copied onto the new task. Returns the newly created
   * series-master task.
   *
   * The anchor is loaded via `findByIdWithRule` (its `group` relation hydrated);
   * recurrence is the inline `recurrenceConfig` on the row, so a real recurring
   * series splits correctly off that value.
   *
   * When `changes.groupId` is provided it is validated against the new master's
   * calendar BEFORE any write and applied in the same insert, so a cross-calendar
   * group is rejected with no partial write (no series split + lost group).
   *
   * Edge cases:
   * - **`originalStart` equals the series start** — no split is needed; collapses
   *   to a plain master `update` (it IS the "all" scope).
   * - **Non-recurring task** — any scope collapses to a single-row `update`.
   * - **COUNT rule split mid-count** — the old side is converted to `UNTIL_DATE`
   *   ending the day before `originalStart`; the new side's `count` is recomputed
   *   as `oldCount − occurrencesBefore`, where `occurrencesBefore` is the number
   *   of occurrences the ORIGINAL rule generates in `[seriesStart, originalStart)`.
   *   The combined old + new occurrence total therefore equals the original
   *   `count` exactly (no phantom extra occurrences). An explicit
   *   `changes.recurrence` overrides the recomputed `count`.
   * - **An exception exactly on the boundary** (`originalStart`) — copied onto the
   *   new task as its first instance's override; no reconciliation against
   *   `changes` is attempted.
   * - **Old exceptions `>= originalStart`** are left on the old task as inert rows
   *   (the now-ended old rule can never reach them); physical deletion is deferred.
   */
  @Transactional()
  async splitSeries(
    userId: string,
    taskId: string,
    originalStart: Date,
    changes: SplitSeriesChanges,
  ): Promise<Task> {
    const task = await this.findByIdWithRule(userId, taskId);

    if (task.recurrenceConfig === null) {
      return this.update(userId, taskId, this.splitChangesAsUpdate(changes));
    }

    if (
      task.startAt !== null &&
      task.startAt.getTime() === originalStart.getTime()
    ) {
      return this.update(userId, taskId, this.splitChangesAsUpdate(changes));
    }

    // Validate the group against the new master's calendar before any write, so
    // a cross-calendar group is rejected with the series still intact.
    if (changes.groupId) {
      await this.ensureGroupInCalendar(changes.groupId, task.calendarId);
    }

    const oldConfig = task.recurrenceConfig;
    const newConfig = this.resolveSplitRecurrence(
      task,
      oldConfig,
      originalStart,
      changes.recurrence,
    );

    // End the OLD series the day before the split by cloning its config and
    // setting the UNTIL boundary in-place — recurrence is inline now, so this is
    // a mutate-and-save on the old anchor rather than a rule-CRUD call. `count`
    // is left as-is (the expander honors it only while endType is COUNT, so a
    // stale value under UNTIL_DATE is inert), matching the prior rule-update.
    task.recurrenceConfig = {
      ...oldConfig,
      endType: RecurrenceEndType.UNTIL_DATE,
      endDate: this.dayBefore(originalStart, task.timezone),
    };
    task.recurrenceUpdatedAt = new Date();
    await this.taskDatabaseService.save(task);

    const durationMillis =
      task.startAt && task.endAt
        ? task.endAt.getTime() - task.startAt.getTime()
        : null;
    // The new master's zone (== the `timezone` field set on it below). A bare
    // move on the split anchor is a naive wall-clock in this zone; an explicit
    // in-string offset is honored.
    const newZone = changes.timezone ?? task.timezone;
    const newStartAt = changes.startAt
      ? (parseWallClockInZone(changes.startAt, newZone) ?? originalStart)
      : originalStart;
    const newEndAt = this.resolveSplitEndAt(
      changes.endAt,
      newStartAt,
      durationMillis,
      newZone,
    );

    const newTask = this.taskDatabaseService.createInstance({
      calendarId: task.calendarId,
      groupId: changes.groupId !== undefined ? changes.groupId : task.groupId,
      title: changes.title ?? task.title,
      notes: changes.notes !== undefined ? changes.notes : task.notes,
      startAt: newStartAt,
      endAt: newEndAt,
      isAllDay: changes.isAllDay ?? task.isAllDay,
      timezone: changes.timezone ?? task.timezone,
      requiresCompletion:
        changes.requiresCompletion !== undefined
          ? changes.requiresCompletion
          : task.requiresCompletion,
      color: changes.color !== undefined ? changes.color : task.color,
      notificationStrategyId: task.notificationStrategyId,
      recurrenceConfig: newConfig,
    });

    const savedTask = await this.taskDatabaseService.save(newTask);

    await this.copyExceptionsFrom(taskId, savedTask.id, originalStart);

    // Re-evaluate the OLD series' override children against its now-truncated
    // rule: those past the split boundary detach (kept + flagged). Reparenting
    // them onto the new series is a deliberate follow-up (see specs).
    await this.sweepOverrideChildren(task, task.recurrenceConfig);

    await this.syncStateService.bump(userId);

    return savedTask;
  }

  /**
   * Soft-deletes a Task by id after asserting ownership. Persists `deletedAt`
   * via `.save()` (per the repo's save-only convention); subsequent finds
   * exclude it by default.
   */
  @Transactional()
  async remove(
    userId: string,
    taskId: string,
    mode: TaskDeleteMode = 'remove',
  ): Promise<void> {
    const task = await this.findById(userId, taskId);

    // Override child: delete-means-delete by default (soft-delete + skip the
    // parent slot), so every caller — REST, the assistant, old iOS builds — makes
    // the occurrence stay gone. `revert` (explicit, the "Revert to series
    // schedule" action) instead restores the generated occurrence, carrying back
    // any completion the child had absorbed.
    if (task.parentTaskId != null && task.originalStartAt != null) {
      const parentTaskId = task.parentTaskId;
      const originalStartAt = task.originalStartAt;

      task.deletedAt = new Date();
      await this.taskDatabaseService.save(task);

      if (mode === 'revert') {
        if (task.completedAt != null) {
          // Re-materialize the pre-override exception so the regenerated slot
          // keeps its completion history (the override absorbed + deleted the
          // original exception when it was created). upsertOverride touches the
          // parent, invalidating the slot's window on clients.
          await this.taskOccurrenceExceptionService.upsertOverride(
            parentTaskId,
            originalStartAt,
            { completedAt: task.completedAt },
          );
        } else {
          await this.taskDatabaseService.touchUpdatedAt(parentTaskId);
        }
      } else {
        // Write the skip UNCONDITIONALLY (even for a currently-detached child):
        // inert now, effective if a later rule edit regenerates the slot,
        // preserving the delete intent across detach/re-attach cycles.
        await this.taskOccurrenceExceptionService.upsertOverride(
          parentTaskId,
          originalStartAt,
          { isSkipped: true },
        );
      }

      await this.syncStateService.bump(userId);

      return;
    }

    // Parent / ordinary task: soft-delete it, then cascade soft-delete every live
    // override child (each needs its OWN tombstone so the delta drops the child
    // rows — a parent-only tombstone would strand them on other devices).
    task.deletedAt = new Date();
    await this.taskDatabaseService.save(task);

    const children = await this.taskDatabaseService.findAllBy({
      parentTaskId: task.id,
    });

    for (const child of children) {
      child.deletedAt = new Date();
      await this.taskDatabaseService.save(child);
    }

    await this.syncStateService.bump(userId);
  }

  /**
   * Truncates a recurring series at `originalStart` (the "delete this and
   * following" scope): ends the rule the day before `originalStart` so PAST
   * occurrences are preserved and the instance + every later one disappear. No
   * new series is created — unlike `splitSeries`, the tail is dropped rather than
   * re-anchored.
   *
   * Edge cases:
   * - **`originalStart` equals the series start** — there is no past to keep, so
   *   the whole task is soft-deleted via `remove` (equivalent to deleting `all`).
   * - **Non-recurring task** — collapses to a soft-delete (`remove`); there is no
   *   config to truncate.
   *
   * Loads the anchor via `findByIdWithRule`; recurrence is the inline
   * `recurrenceConfig` on the row. Validates ownership first.
   */
  @Transactional()
  async endSeriesAt(
    userId: string,
    taskId: string,
    originalStart: Date,
  ): Promise<void> {
    const task = await this.findByIdWithRule(userId, taskId);

    if (task.recurrenceConfig === null) {
      await this.remove(userId, taskId);

      return;
    }

    if (
      task.startAt !== null &&
      task.startAt.getTime() === originalStart.getTime()
    ) {
      await this.remove(userId, taskId);

      return;
    }

    // Truncate by setting the UNTIL boundary in-place on the inline config.
    task.recurrenceConfig = {
      ...task.recurrenceConfig,
      endType: RecurrenceEndType.UNTIL_DATE,
      endDate: this.dayBefore(originalStart, task.timezone),
    };
    task.recurrenceUpdatedAt = new Date();
    await this.taskDatabaseService.save(task);

    // Override children past the new cut are no longer generated: detach them
    // (kept + flagged rather than destroyed — a user edit survives a rule edit).
    await this.sweepOverrideChildren(task, task.recurrenceConfig);

    await this.syncStateService.bump(userId);
  }

  /**
   * Returns the tasks in a calendar that clash with the half-open window
   * `[startAt, endAt)` — the server-side conflict check (ADR 0006 layer 4),
   * excluding the task being edited. A timed one-off clashes when its
   * `[startAt, endAt)` overlaps; an end-less one-off (point / all-day-without-end)
   * clashes when its `startAt` falls within `[startAt, endAt)` — mirroring the
   * `timedNoEnd` bucket of `findOccurrencesInRange`; a recurring series clashes
   * when any occurrence expanded into the bounded window overlaps (the anchor row
   * is returned). Completed events/occurrences are never treated as live
   * conflicts. Series-wide clash detection is out of scope — only the bounded
   * window is tested.
   */
  async findOverlapping(
    userId: string,
    calendarId: string,
    startAt: Date,
    endAt: Date,
    excludeTaskId?: string,
  ): Promise<Task[]> {
    await this.ensureCalendarOwnedByUser(calendarId, userId);

    const excludeScope = excludeTaskId ? { id: Not(excludeTaskId) } : {};

    const timedClashes = await this.taskDatabaseService.findAll({
      where: {
        calendarId,
        recurrenceConfig: IsNull(),
        completedAt: IsNull(),
        startAt: LessThan(endAt),
        endAt: MoreThan(startAt),
        ...excludeScope,
      },
      order: { startAt: 'ASC' },
    });

    const noEndClashes = await this.taskDatabaseService.findAll({
      where: {
        calendarId,
        recurrenceConfig: IsNull(),
        completedAt: IsNull(),
        startAt: And(MoreThanOrEqual(startAt), LessThan(endAt)),
        endAt: IsNull(),
        ...excludeScope,
      },
      order: { startAt: 'ASC' },
    });

    const recurringClashes = await this.findClashingRecurringAnchors(
      calendarId,
      startAt,
      endAt,
      excludeTaskId,
    );

    return this.dedupeById([
      ...timedClashes,
      ...noEndClashes,
      ...recurringClashes,
    ]).sort(
      (left, right) =>
        this.startSortKey(left.startAt) - this.startSortKey(right.startAt),
    );
  }

  /**
   * Conflict-checks a PROPOSED recurring series — the write-side counterpart of
   * `findOverlapping` for a whole series (Story 9). It expands the proposal over
   * the bounded look-ahead horizon (`RecurrenceRuleService.previewSeriesOccurrences`,
   * itself capped by `MAX_OCCURRENCES_PER_WINDOW` / `MAX_GENERATION_STEPS`, so it
   * can never hang), then overlap-checks every generated occurrence window against
   * existing events via the SAME occurrence-aware `findOverlapping` the one-off
   * hold trusts — so a "clear" verdict here and the per-occurrence write later
   * never disagree. `excludeTaskId` drops the series being edited from its own
   * scan (a recurring edit must not clash with its current occupancy).
   *
   * Returns the distinct clashing occurrence start dates and the de-duplicated
   * existing tasks they clash against; an empty `conflictDates` means the series
   * is clear within the horizon. Only a timed series (a concrete `endAt`) can
   * conflict — callers pass one. A clash that first arises only beyond the horizon
   * is an accepted, documented miss (see `PREVIEW_SERIES_HORIZON_DAYS`).
   */
  async findRecurringSeriesConflicts(
    userId: string,
    calendarId: string,
    proposal: ProposedSeries,
    excludeTaskId?: string,
  ): Promise<RecurringSeriesConflicts> {
    await this.ensureCalendarOwnedByUser(calendarId, userId);

    const occurrences =
      this.recurrenceRuleService.previewSeriesOccurrences(proposal);
    const conflictDates: Date[] = [];
    const conflictingTasks: Task[] = [];

    for (const occurrence of occurrences) {
      // Only timed occurrences (concrete start AND end) can overlap; a proposed
      // series always carries an end, but the engine yields null-ended instances
      // for an open-ended anchor — skip those defensively rather than probe.
      if (
        occurrence.occurrenceStart === null ||
        occurrence.occurrenceEnd === null
      ) {
        continue;
      }

      const conflicts = await this.findOverlapping(
        userId,
        calendarId,
        occurrence.occurrenceStart,
        occurrence.occurrenceEnd,
        excludeTaskId,
      );

      if (conflicts.length === 0) continue;

      conflictDates.push(occurrence.occurrenceStart);
      conflictingTasks.push(...conflicts);
    }

    return {
      conflictDates,
      conflictingTasks: this.dedupeById(conflictingTasks),
    };
  }

  /**
   * Conflict-checks a proposed EDIT to an existing recurring series (Story 9): it
   * resolves the EFFECTIVE post-edit series (the proposed time/recurrence merged
   * over the task's current values), then delegates to
   * {@link findRecurringSeriesConflicts}, excluding the series being edited from
   * its own scan (its current occupancy must not register as a clash).
   *
   * Returns no conflicts (an empty result) when the edit cannot produce a timed
   * recurring series to check — the task is not recurring, the effective series
   * has no concrete `startAt`/`endAt`, or neither the time nor the rule changed
   * (so the occupancy is unchanged and was already conflict-free at create time).
   */
  async findRecurringEditConflicts(
    userId: string,
    taskId: string,
    proposal: RecurringEditProposal,
  ): Promise<RecurringSeriesConflicts> {
    const task = await this.findByIdWithRule(userId, taskId);

    const effectiveRecurrence =
      proposal.recurrence ?? this.configToCreateDto(task.recurrenceConfig);

    // Not a recurring series after the edit ⇒ nothing series-shaped to check.
    if (!effectiveRecurrence) {
      return { conflictDates: [], conflictingTasks: [] };
    }

    const timeChanged =
      proposal.startAt !== undefined || proposal.endAt !== undefined;
    const recurrenceChanged = proposal.recurrence !== undefined;

    // Neither the window nor the rule moved ⇒ occupancy is unchanged; it was
    // already conflict-free when first created, so re-checking is pure cost.
    if (!timeChanged && !recurrenceChanged) {
      return { conflictDates: [], conflictingTasks: [] };
    }

    // The effective series is expanded in the NEXT zone (the resolved user zone
    // the dispatcher passes, else the task's current zone), and a bare move is
    // localized in it — so the conflict window matches the instant the write
    // persists. An explicit in-string offset is honored by the helper.
    const nextZone = proposal.timezone ?? task.timezone;
    const startAt = proposal.startAt
      ? parseWallClockInZone(proposal.startAt, nextZone)
      : task.startAt;
    const endAt = proposal.endAt
      ? parseWallClockInZone(proposal.endAt, nextZone)
      : task.endAt;

    // Only a timed series (a concrete window) can overlap; an open-ended or
    // timeless effective series is non-conflicting by construction.
    if (!startAt || !endAt) {
      return { conflictDates: [], conflictingTasks: [] };
    }

    return this.findRecurringSeriesConflicts(
      userId,
      task.calendarId,
      {
        title: proposal.title ?? task.title,
        startAt,
        endAt,
        timezone: nextZone,
        recurrence: effectiveRecurrence,
      },
      taskId,
    );
  }

  /**
   * Maps an inline `RecurrenceConfig` back to the `CreateRecurrenceRuleDto` shape
   * the conflict-preview expects, so an edit that changes only the TIME (not the
   * rule) still expands the series against its CURRENT config. Returns null when no
   * config is supplied (a non-recurring task).
   */
  private configToCreateDto(
    config: RecurrenceConfig | null,
  ): CreateRecurrenceRuleDto | null {
    if (!config) return null;

    return {
      frequency: config.frequency,
      interval: config.interval,
      byWeekday: config.byWeekday ?? undefined,
      byMonthDay: config.byMonthDay ?? undefined,
      byMonth: config.byMonth ?? undefined,
      endType: config.endType,
      endDate: config.endDate ?? undefined,
      count: config.count ?? undefined,
    };
  }

  /**
   * Resolves the set of calendar ids a range read should span: a single
   * explicit, ownership-checked calendar, or every calendar the user owns.
   */
  private async resolveCalendarScope(
    userId: string,
    calendarId?: string,
  ): Promise<string[]> {
    if (calendarId) {
      await this.ensureCalendarOwnedByUser(calendarId, userId);

      return [calendarId];
    }

    const calendars = await this.calendarDatabaseService.findAllByOwner(userId);

    return calendars.map((calendar) => calendar.id);
  }

  /**
   * True when a task with no own recurrence rule actually recurs via its group's
   * default rule — in which case `readRecurringOccurrences` owns its expansion and
   * it must NOT also be wrapped as a flat one-off (which would double-count it:
   * once as a non-recurring row at its anchor, once as the expanded series).
   * Guards on `startAt`: a timeless todo produces no occurrences, so it is never
   * owned by the recurring path and still surfaces through the todo read.
   */
  private inheritsGroupRecurrence(task: Task): boolean {
    // An override child is a materialized one-off, never owned by the recurring
    // path — it must stay in the one-off read (and never be filtered out of it),
    // otherwise it vanishes from every window (the anchor scan excludes children
    // too). This is the third of the three "children never recur" gates.
    if (task.parentTaskId != null) return false;

    return task.startAt !== null && task.group?.recurrenceConfig != null;
  }

  /**
   * Reads one-off tasks intersecting `[from, to)` and wraps each as a single
   * `Occurrence`. Timed/all-day events are matched by half-open intersection;
   * timeless todos are loaded only when `includeTodos`. Timed tasks that recur via
   * their group's default rule are excluded here — they belong to
   * `readRecurringOccurrences` (see {@link inheritsGroupRecurrence}).
   */
  private async readOneOffOccurrences(
    calendarIds: string[],
    from: Date,
    to: Date,
    opts: FindOccurrencesOptions,
  ): Promise<Occurrence[]> {
    const calendarScope = In(calendarIds);
    const groupScope = opts.groupId ? { groupId: opts.groupId } : {};

    // Load the group relation so group-inherited recurring tasks can be filtered
    // out — without it `task.group` is undefined and the filter is a no-op.
    const timedWithEnd = await this.taskDatabaseService.findAll({
      where: {
        calendarId: calendarScope,
        recurrenceConfig: IsNull(),
        startAt: LessThan(to),
        endAt: MoreThan(from),
        ...groupScope,
      },
      relations: { group: true },
    });
    const timedNoEnd = await this.taskDatabaseService.findAll({
      where: {
        calendarId: calendarScope,
        recurrenceConfig: IsNull(),
        startAt: And(MoreThanOrEqual(from), LessThan(to)),
        endAt: IsNull(),
        ...groupScope,
      },
      relations: { group: true },
    });

    const occurrences = [...timedWithEnd, ...timedNoEnd]
      .filter((task) => !this.inheritsGroupRecurrence(task))
      .map((task) => this.wrapOneOff(task));

    if (!opts.includeTodos) return occurrences;

    // Timeless todos cannot recur (a null `startAt` yields no occurrences), so
    // they are never owned by the recurring path — no group-inheritance filter.
    // The group relation is still loaded so the occurrence carries the owning
    // group's color (B2).
    const todos = await this.taskDatabaseService.findAll({
      where: {
        calendarId: calendarScope,
        recurrenceConfig: IsNull(),
        startAt: IsNull(),
        ...groupScope,
      },
      relations: { group: true },
    });

    return [...occurrences, ...todos.map((task) => this.wrapOneOff(task))];
  }

  /**
   * Loads every recurring anchor in scope and expands each into `[from, to)`,
   * loading per-anchor exceptions on demand.
   *
   * A task is a recurring anchor when EITHER it has its own `recurrenceConfig`
   * OR its group carries a `recurrenceConfig` (group inheritance). The effective
   * config is resolved task-wins as
   * `task.recurrenceConfig ?? task.group.recurrenceConfig`. Own-config anchors
   * need no relation (the config is on the row); group-inherited anchors load the
   * group to read its inline config.
   */
  private async readRecurringOccurrences(
    calendarIds: string[],
    from: Date,
    to: Date,
    groupId?: string,
  ): Promise<Occurrence[]> {
    // Own-config anchors: tasks with their own inline recurrenceConfig set. The
    // group relation is loaded so each expanded occurrence carries the owning
    // group's color (B2), even though the recurrence comes from the row itself.
    const ownRuleAnchors = await this.taskDatabaseService.findAll({
      where: {
        calendarId: In(calendarIds),
        recurrenceConfig: Not(IsNull()),
        // Override children never expand as a series (they carry no own config
        // anyway, but exclude explicitly as the second "children never recur" gate).
        parentTaskId: IsNull(),
        ...(groupId ? { groupId } : {}),
      },
      relations: { group: true },
    });

    // Group-inherited anchors: tasks with NO own config but assigned to a group.
    // Load the group so its inline recurrenceConfig can be read.
    const groupInheritedAnchors = await this.taskDatabaseService.findAll({
      where: {
        calendarId: In(calendarIds),
        recurrenceConfig: IsNull(),
        groupId: Not(IsNull()),
        // Exclude override children: a child inside a group that carries a rule
        // would otherwise be expanded here (config null + groupId set) instead of
        // surfacing as the materialized one-off it is.
        parentTaskId: IsNull(),
        ...(groupId ? { groupId } : {}),
      },
      relations: { group: true },
    });

    const occurrences: Occurrence[] = [];

    for (const anchor of ownRuleAnchors) {
      if (!anchor.recurrenceConfig) continue;

      const exceptions = await this.taskOccurrenceExceptionService.findForTask(
        anchor.id,
      );

      occurrences.push(
        ...this.recurrenceRuleService.expandOccurrences(
          anchor,
          anchor.recurrenceConfig,
          exceptions,
          from,
          to,
          RecurrenceSource.TASK,
        ),
      );
    }

    for (const anchor of groupInheritedAnchors) {
      const inheritedConfig = anchor.group?.recurrenceConfig ?? null;

      if (!inheritedConfig) continue;

      const exceptions = await this.taskOccurrenceExceptionService.findForTask(
        anchor.id,
      );

      occurrences.push(
        ...this.recurrenceRuleService.expandOccurrences(
          anchor,
          inheritedConfig,
          exceptions,
          from,
          to,
          // Group-inherited: the summary records the group source + name (the
          // group relation is loaded above so `anchor.group.name` is available).
          RecurrenceSource.GROUP,
        ),
      );
    }

    return occurrences;
  }

  /**
   * Loads recurring anchors in a calendar and returns those with at least one
   * non-completed occurrence intersecting the bounded window. Includes both tasks
   * with their own inline config and tasks inheriting a config from their group.
   * The expander already window-clips to intersection (skipped occurrences are
   * dropped by the engine), so any in-window occurrence is, by construction, a
   * clash — except a per-instance-completed one, which is a finished item rather
   * than a live conflict and is filtered out here (mirroring `findOccurrencesInRange`).
   */
  private async findClashingRecurringAnchors(
    calendarId: string,
    startAt: Date,
    endAt: Date,
    excludeTaskId?: string,
  ): Promise<Task[]> {
    const excludeScope = excludeTaskId ? { id: Not(excludeTaskId) } : {};

    const ownRuleAnchors = await this.taskDatabaseService.findAll({
      where: {
        calendarId,
        recurrenceConfig: Not(IsNull()),
        parentTaskId: IsNull(),
        ...excludeScope,
      },
    });

    const groupInheritedAnchors = await this.taskDatabaseService.findAll({
      where: {
        calendarId,
        recurrenceConfig: IsNull(),
        groupId: Not(IsNull()),
        // Exclude override children (config null + groupId set) — a moved child
        // is conflict-checked via the one-off timed clash query, not as a series.
        parentTaskId: IsNull(),
        ...excludeScope,
      },
      relations: { group: true },
    });

    // A slot overridden by a live child is vacated at its original time — the
    // child's new time is checked as a one-off. Suppress those slots so the
    // parent's expansion does not report a phantom conflict at the vacated slot.
    const suppressedSlots = await this.buildOverrideSuppressionSet(
      [calendarId],
      startAt,
      endAt,
    );

    const clashing: Task[] = [];

    const checkAnchor = async (
      anchor: Task,
      effectiveConfig: RecurrenceConfig,
    ): Promise<void> => {
      const exceptions = await this.taskOccurrenceExceptionService.findForTask(
        anchor.id,
      );
      const occurrences = this.recurrenceRuleService.expandOccurrences(
        anchor,
        effectiveConfig,
        exceptions,
        startAt,
        endAt,
      );

      const hasLiveOccurrence = occurrences.some(
        (occurrence) =>
          occurrence.completedAt === null &&
          !(
            occurrence.originalStart &&
            suppressedSlots.has(
              this.overrideSlotKey(anchor.id, occurrence.originalStart),
            )
          ),
      );

      if (hasLiveOccurrence) {
        clashing.push(anchor);
      }
    };

    for (const anchor of ownRuleAnchors) {
      if (!anchor.recurrenceConfig) continue;

      await checkAnchor(anchor, anchor.recurrenceConfig);
    }

    for (const anchor of groupInheritedAnchors) {
      const inheritedConfig = anchor.group?.recurrenceConfig ?? null;

      if (!inheritedConfig) continue;

      await checkAnchor(anchor, inheritedConfig);
    }

    return this.dedupeById(clashing);
  }

  /**
   * Wraps a non-recurring task as a single `Occurrence` mirroring the row. A
   * timed/all-day one-off carries its `startAt`; a timeless todo carries a null
   * start honestly (the `Occurrence` contract permits null start for exactly this
   * case), and such todos sort last in the merged stream.
   */
  private wrapOneOff(task: Task): Occurrence {
    return {
      task,
      originalStart: task.startAt,
      occurrenceStart: task.startAt,
      occurrenceEnd: task.endAt,
      title: task.title,
      completedAt: task.completedAt,
      isRecurring: false,
      isException: false,
      recurrence: null,
      // A materialized override child surfaces through this one-off path; carry
      // its provenance so the client can render/route it. Ordinary one-offs have
      // parentTaskId null and are never detached.
      parentTaskId: task.parentTaskId,
      isDetached: task.detachedAt != null,
    };
  }

  /**
   * Applies the recurrence portion of an update to the master by mutating the
   * inline `recurrenceConfig` on the task row: clears it when `recurrence` is
   * explicitly null, sets/replaces it from the DTO otherwise. Returns whether the
   * config actually changed (so the caller knows to `save` even when no other
   * field did). The config lives on the row, so there is no separate rule
   * lifecycle to create / delete (ADR 0054).
   */
  private applyRecurrenceUpdate(task: Task, input: UpdateTaskInput): boolean {
    if (input.recurrence === undefined) return false;

    if (input.recurrence === null) {
      if (task.recurrenceConfig === null) return false;

      task.recurrenceConfig = null;

      return true;
    }

    task.recurrenceConfig = RecurrenceRuleService.toConfig(input.recurrence);

    return true;
  }

  /**
   * Collapses a single-occurrence override onto a non-recurring master: a skip
   * soft-deletes the task; otherwise the override fields map onto a plain update.
   */
  private async collapseOverrideToMaster(
    userId: string,
    taskId: string,
    changes: OccurrenceOverrideChanges,
  ): Promise<void> {
    if (changes.isSkipped) {
      await this.remove(userId, taskId);

      return;
    }

    await this.update(userId, taskId, {
      ...(changes.overrideTitle != null
        ? { title: changes.overrideTitle }
        : {}),
      ...(changes.overrideStartAt !== undefined
        ? { startAt: changes.overrideStartAt?.toISOString() ?? null }
        : {}),
      ...(changes.overrideEndAt !== undefined
        ? { endAt: changes.overrideEndAt?.toISOString() ?? null }
        : {}),
    });

    if (changes.completedAt !== undefined) {
      await this.setCompleted(userId, taskId, changes.completedAt !== null);
    }
  }

  /**
   * Reports whether the override changes actually mutate the instance's
   * scheduling/title (as opposed to a pure skip or completion-only change, which
   * the spec keeps lenient). Used to gate the occurrence-membership guard.
   */
  private isOverrideMutation(changes: OccurrenceOverrideChanges): boolean {
    return (
      changes.overrideStartAt !== undefined ||
      changes.overrideEndAt !== undefined ||
      changes.overrideTitle !== undefined
    );
  }

  /**
   * Asserts that `originalStart` is a real occurrence the series actually
   * generates, by expanding a tight 1ms-bracketed window around it via the
   * recurrence engine and matching the generated `originalStart`. Reads the inline
   * `recurrenceConfig` straight off the passed task (already loaded by the caller);
   * throws when no config is set or no occurrence lands on the coordinate ("not an
   * occurrence of this series"), preventing a phantom inert exception row. The
   * window is deliberately bounded to a single instant so expansion stays cheap.
   */
  private ensureGeneratedOccurrence(task: Task, originalStart: Date): void {
    if (
      !task.recurrenceConfig ||
      !this.isGeneratedOccurrence(task, task.recurrenceConfig, originalStart)
    ) {
      throw new BadRequestException(
        'originalStart is not an occurrence of this series',
      );
    }
  }

  /**
   * Effective-config variant of {@link ensureGeneratedOccurrence} for the
   * override endpoint: validates membership against the task's EFFECTIVE rule
   * (own ?? group-inherited) rather than only its own config, so a
   * group-recurring parent is not wrongly rejected. Throws
   * `OCCURRENCE_NOT_GENERATED` when the coordinate is not a generated slot.
   */
  private ensureGeneratedOccurrenceEffective(
    task: Task,
    effectiveConfig: RecurrenceConfig | null,
    originalStart: Date,
  ): void {
    if (
      !effectiveConfig ||
      !this.isGeneratedOccurrence(task, effectiveConfig, originalStart)
    ) {
      throw new BadRequestException({
        code: OCCURRENCE_NOT_GENERATED,
        message: 'originalStart is not an occurrence of this series',
      });
    }
  }

  /**
   * Returns whether `config` generates an occurrence exactly at `originalStart`,
   * by expanding a tight 1ms-bracketed window around the coordinate. Expands with
   * NO exceptions so a pre-existing skip/override on the slot does not hide the
   * otherwise-valid occurrence. The window is a single instant so expansion is
   * cheap.
   */
  private isGeneratedOccurrence(
    task: Task,
    config: RecurrenceConfig,
    originalStart: Date,
  ): boolean {
    const originalStartMillis = originalStart.getTime();
    const occurrences = this.recurrenceRuleService.expandOccurrences(
      task,
      config,
      [],
      new Date(originalStartMillis - 1),
      new Date(originalStartMillis + 1),
    );

    return occurrences.some(
      (occurrence) =>
        occurrence.originalStart?.getTime() === originalStartMillis,
    );
  }

  /**
   * Resolves a task's effective recurrence config, loading its group on demand
   * when the task inherits (no own config, has a group). Returns null for an
   * override child or a genuinely non-recurring task. Used by the detach sweep
   * and the override endpoint, which start from a relation-less loaded task.
   */
  private async resolveEffectiveConfigForTask(
    task: Task,
  ): Promise<RecurrenceConfig | null> {
    if (task.parentTaskId != null) return null;

    if (task.recurrenceConfig) return task.recurrenceConfig;

    if (!task.groupId) return null;

    const group =
      task.group ??
      (await this.taskGroupDatabaseService.findOneBy({ id: task.groupId }));

    return group?.recurrenceConfig ?? null;
  }

  /**
   * Re-evaluates every live override child of `parent` against the parent's
   * CURRENT effective rule and flips `detachedAt`: sets it when the child's
   * original slot is no longer generated (rule / anchor edit rekeyed the series),
   * clears it when a later revert regenerates the slot. Keep-as-detached — the
   * child (a real user edit) is never destroyed by a rule tweak.
   */
  private async sweepOverrideChildren(
    parent: Task,
    effectiveConfig: RecurrenceConfig | null,
  ): Promise<void> {
    const children = await this.taskDatabaseService.findAllBy({
      parentTaskId: parent.id,
    });

    for (const child of children) {
      if (child.originalStartAt === null) continue;

      const generated =
        effectiveConfig != null &&
        this.isGeneratedOccurrence(parent, effectiveConfig, child.originalStartAt);

      if (!generated && child.detachedAt === null) {
        child.detachedAt = new Date();
        await this.taskDatabaseService.save(child);
      } else if (generated && child.detachedAt !== null) {
        child.detachedAt = null;
        await this.taskDatabaseService.save(child);
      }
    }
  }

  /**
   * Maps split changes onto an `UpdateTaskInput` for the no-split paths
   * (non-recurring task, or split exactly at the series start).
   */
  private splitChangesAsUpdate(changes: SplitSeriesChanges): UpdateTaskInput {
    return {
      ...(changes.title !== undefined ? { title: changes.title } : {}),
      ...(changes.notes !== undefined ? { notes: changes.notes } : {}),
      ...(changes.startAt !== undefined ? { startAt: changes.startAt } : {}),
      ...(changes.endAt !== undefined ? { endAt: changes.endAt } : {}),
      ...(changes.groupId !== undefined ? { groupId: changes.groupId } : {}),
      ...(changes.isAllDay !== undefined ? { isAllDay: changes.isAllDay } : {}),
      ...(changes.timezone !== undefined ? { timezone: changes.timezone } : {}),
      ...(changes.requiresCompletion !== undefined
        ? { requiresCompletion: changes.requiresCompletion }
        : {}),
      ...(changes.color !== undefined ? { color: changes.color } : {}),
      ...(changes.recurrence !== undefined
        ? { recurrence: changes.recurrence }
        : {}),
    };
  }

  /**
   * Copies every exception of the old task dated `>= splitStart` onto the new
   * task, preserving the per-instance override fields. The old rows are left in
   * place but inert (the old rule no longer reaches them).
   */
  private async copyExceptionsFrom(
    oldTaskId: string,
    newTaskId: string,
    splitStart: Date,
  ): Promise<void> {
    const exceptions =
      await this.taskOccurrenceExceptionService.findForTask(oldTaskId);
    const splitMillis = splitStart.getTime();

    for (const exception of exceptions) {
      if (exception.originalStartAt.getTime() < splitMillis) continue;

      await this.taskOccurrenceExceptionService.upsertOverride(
        newTaskId,
        exception.originalStartAt,
        {
          overrideStartAt: exception.overrideStartAt,
          overrideEndAt: exception.overrideEndAt,
          overrideTitle: exception.overrideTitle,
          isSkipped: exception.isSkipped,
          completedAt: exception.completedAt,
        },
      );
    }
  }

  /**
   * Builds the inline recurrence config for the new (post-split) series: the old
   * config cloned, then any `changes.recurrence` overlaid. For a `COUNT` old config
   * with no explicit `count` override, the new side's `count` is recomputed so the
   * combined old + new total equals the ORIGINAL count exactly — see
   * `countOccurrencesBefore`. `UNTIL_DATE` / `NEVER` configs need no recount.
   */
  private resolveSplitRecurrence(
    task: Task,
    oldConfig: RecurrenceConfig,
    originalStart: Date,
    overrides?: CreateRecurrenceRuleDto,
  ): RecurrenceConfig {
    const cloned = this.cloneConfigWithOverrides(oldConfig, overrides);

    const isCountRule =
      oldConfig.endType === RecurrenceEndType.COUNT && oldConfig.count !== null;
    const overridesCount = overrides?.count !== undefined;

    if (!isCountRule || overridesCount) return cloned;

    const occurrencesBefore = this.countOccurrencesBefore(
      task,
      oldConfig,
      originalStart,
    );

    return {
      ...cloned,
      count: Math.max(0, (oldConfig.count as number) - occurrencesBefore),
    };
  }

  /**
   * Counts how many occurrences the ORIGINAL config generates in the half-open
   * window `[seriesStart, originalStart)` — i.e. strictly before the split
   * boundary. Expansion runs with NO exceptions (membership is a property of the
   * config, not of overrides) over a window that starts 1ms before the anchor so
   * the very first occurrence is never dropped by the intersection clip. Used to
   * recompute the new side's `count` on a COUNT split.
   */
  private countOccurrencesBefore(
    task: Task,
    oldConfig: RecurrenceConfig,
    originalStart: Date,
  ): number {
    if (!task.startAt) return 0;

    const windowFrom = new Date(task.startAt.getTime() - 1);

    return this.recurrenceRuleService.expandOccurrences(
      task,
      oldConfig,
      [],
      windowFrom,
      originalStart,
    ).length;
  }

  /**
   * Clones an existing inline config, then overlays ONLY the recurrence DTO fields
   * the caller actually provided (used to build the new series' config on a split).
   * Each absent DTO key leaves the old config's value intact — mirroring the prior
   * `{ ...base, ...changes }` clone — so a partial `changes.recurrence` (e.g. just
   * `frequency`) never resets the unmentioned axes to their defaults. Provided
   * optional axes (`byWeekday`/`byMonthDay`/`byMonth`/`endDate`/`count`) collapse a
   * value to null when the DTO carried it as such; an omitted key is untouched.
   */
  private cloneConfigWithOverrides(
    config: RecurrenceConfig,
    changes?: CreateRecurrenceRuleDto,
  ): RecurrenceConfig {
    if (!changes) return { ...config };

    return {
      ...config,
      ...(changes.frequency !== undefined
        ? { frequency: changes.frequency }
        : {}),
      ...(changes.interval !== undefined ? { interval: changes.interval } : {}),
      ...(changes.byWeekday !== undefined
        ? { byWeekday: changes.byWeekday }
        : {}),
      ...(changes.byMonthDay !== undefined
        ? { byMonthDay: changes.byMonthDay }
        : {}),
      ...(changes.byMonth !== undefined ? { byMonth: changes.byMonth } : {}),
      ...(changes.endType !== undefined ? { endType: changes.endType } : {}),
      ...(changes.endDate !== undefined ? { endDate: changes.endDate } : {}),
      ...(changes.count !== undefined ? { count: changes.count } : {}),
    };
  }

  /**
   * Resolves the new anchor's `endAt` for a split: an explicit value wins (a
   * naive wall-clock interpreted in `zone`, an explicit in-string offset
   * honored), else the cloned anchor preserves the original duration, else null.
   */
  private resolveSplitEndAt(
    explicitEndAt: string | null | undefined,
    newStartAt: Date,
    durationMillis: number | null,
    zone: string,
  ): Date | null {
    if (explicitEndAt !== undefined) {
      return explicitEndAt ? parseWallClockInZone(explicitEndAt, zone) : null;
    }

    if (durationMillis === null) return null;

    return new Date(newStartAt.getTime() + durationMillis);
  }

  /**
   * Resolves a "next" date from an optional ISO input: a string parses to a
   * `Date` (a naive wall-clock interpreted in `zone`, an explicit in-string
   * offset honored), an explicit null clears, and `undefined` keeps the current
   * value. An unparseable string yields null (treated as a clear).
   */
  private resolveNextDate(
    input: string | null | undefined,
    current: Date | null,
    zone: string,
  ): Date | null {
    if (input === undefined) return current;

    return input ? parseWallClockInZone(input, zone) : null;
  }

  /**
   * Returns the inclusive UNTIL boundary one day before `instant`, as a
   * `yyyy-mm-dd` date string in the task's timezone.
   */
  private dayBefore(instant: Date, zone: string): string {
    return DateTime.fromJSDate(instant, { zone })
      .minus({ days: 1 })
      .toISODate() as string;
  }

  /**
   * Sort key for a possibly-null occurrence start: timeless todos (null) sort to
   * the end deterministically.
   */
  private startSortKey(start: Date | null): number {
    return start ? start.getTime() : Number.POSITIVE_INFINITY;
  }

  /**
   * Escapes the `ILIKE` wildcards (`%`, `_`) and the escape char (`\`) in a raw
   * user search term so they match literally rather than as patterns.
   */
  private escapeLike(term: string): string {
    return term.replace(/[\\%_]/g, (match) => `\\${match}`);
  }

  /**
   * Returns the input tasks with duplicates (by id) removed, keeping first-seen
   * order.
   */
  private dedupeById(tasks: Task[]): Task[] {
    const seen = new Set<string>();
    const unique: Task[] = [];

    for (const task of tasks) {
      if (seen.has(task.id)) continue;

      seen.add(task.id);
      unique.push(task);
    }

    return unique;
  }

  /**
   * Loads a group and asserts it lives in the expected calendar.
   * Throws 404 when the group is missing, 400 when it belongs to a different
   * calendar.
   */
  private async ensureGroupInCalendar(
    groupId: string,
    calendarId: string,
  ): Promise<void> {
    const group = await this.taskGroupDatabaseService.findOneBy({
      id: groupId,
    });

    if (!group) {
      throw new EntityNotFoundException(TaskGroup);
    }

    if (group.calendarId !== calendarId) {
      throw new BadRequestException(
        'group must belong to the same calendar as the task',
      );
    }
  }

  /**
   * Loads the calendar and asserts the given user owns it.
   * Throws 404 when missing, 403 when owned by someone else.
   */
  private async ensureCalendarOwnedByUser(
    calendarId: string,
    userId: string,
  ): Promise<void> {
    const calendar = await this.calendarDatabaseService.findOneBy({
      id: calendarId,
    });

    if (!calendar) {
      throw new EntityNotFoundException(Calendar);
    }

    if (calendar.ownerId !== userId) {
      throw new ForbiddenException('You do not have access to this calendar');
    }
  }
}
