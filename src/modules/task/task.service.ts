import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { DateTime } from 'luxon';
import {
  And,
  In,
  IsNull,
  LessThan,
  MoreThan,
  MoreThanOrEqual,
  Not,
} from 'typeorm';

import { CreateTaskDto } from './dtos';
import { EntityNotFoundException } from '@/exceptions/entity-not-found.exception';
import {
  Calendar,
  RecurrenceEndType,
  RecurrenceRule,
  Task,
  TaskGroup,
} from '@/modules/database/entities';
import {
  CalendarDatabaseService,
  TaskDatabaseService,
  TaskGroupDatabaseService,
} from '@/modules/database/services';
import { CreateRecurrenceRuleDto } from '@/modules/recurrence-rule/dtos';
import { RecurrenceRuleService } from '@/modules/recurrence-rule/recurrence-rule.service';
import { Occurrence } from '@/modules/recurrence-rule/recurrence.types';
import {
  OccurrenceOverrideChanges,
  TaskOccurrenceExceptionService,
} from '@/modules/task-occurrence-exception/task-occurrence-exception.service';

/**
 * Fields the assistant may change on an existing event (the "all" / one-off
 * scope). `startAt`/`endAt`/`notes`/`groupId` accept `null` to clear; an omitted
 * key leaves the current value untouched. `recurrence` set to a DTO adds or
 * replaces the master rule; set to `null` removes recurrence entirely.
 * `isAllDay`/`requiresCompletion` are optional booleans — omitted keys default to
 * undefined, so existing callers (the assistant) are unaffected.
 */
export interface UpdateTaskInput {
  title?: string;
  notes?: string | null;
  startAt?: string | null;
  endAt?: string | null;
  isAllDay?: boolean;
  requiresCompletion?: boolean;
  groupId?: string | null;
  recurrence?: CreateRecurrenceRuleDto | null;
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
 * and applied atomically in the same insert — never as a follow-up write. All
 * keys are optional — an empty object splits the series at `originalStart`
 * without otherwise altering it.
 */
export interface SplitSeriesChanges {
  title?: string;
  notes?: string | null;
  startAt?: string | null;
  endAt?: string | null;
  groupId?: string | null;
  recurrence?: CreateRecurrenceRuleDto;
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
  ) {}

  /**
   * Creates a new Task inside the Calendar identified by `dto.calendarId`.
   * Supports timed/all-day events, todos (null `startAt`/`endAt`), an optional
   * `groupId` (which must live in the same calendar), and an optional
   * `recurrence` rule — which is persisted as a single linked `RecurrenceRule`,
   * never as N materialized rows.
   * Throws 404 when the calendar is missing, 403 when it belongs to another user,
   * and 400 when `endAt` precedes `startAt`, the group is in another calendar, or
   * a recurrence is requested without an anchor `startAt`.
   */
  async create(userId: string, dto: CreateTaskDto): Promise<Task> {
    await this.ensureCalendarOwnedByUser(dto.calendarId, userId);

    const startAt = dto.startAt ? new Date(dto.startAt) : null;
    const endAt = dto.endAt ? new Date(dto.endAt) : null;

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

    const recurrenceRuleId = dto.recurrence
      ? (await this.recurrenceRuleService.create(dto.recurrence)).id
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
      requiresCompletion: dto.requiresCompletion ?? true,
      recurrenceRuleId,
    });

    return this.taskDatabaseService.save(task);
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
   * Returns the merged, time-sorted stream of occurrences intersecting the
   * half-open window `[from, to)` for the calendars the user owns: one-off tasks
   * wrapped as single occurrences, plus every recurring anchor expanded via
   * `RecurrenceRuleService.expandOccurrences`. Each recurring anchor's rule is
   * loaded through the `recurrenceRule` relation and its exceptions through
   * `TaskOccurrenceExceptionService.findForTask`. Completed instances are dropped
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

    const merged = [...oneOffOccurrences, ...recurringOccurrences].filter(
      (occurrence) => opts.includeCompleted || occurrence.completedAt === null,
    );

    return merged.sort(
      (left, right) =>
        this.startSortKey(left.occurrenceStart) -
        this.startSortKey(right.occurrenceStart),
    );
  }

  /**
   * Toggles the Task's completion state by id (series-master or one-off).
   * When `isCompleted` is true, stamps `completedAt = new Date()` only if
   * not already set (idempotent). When false, clears `completedAt`.
   * Throws 404 when the task does not exist.
   */
  async setCompleted(id: string, isCompleted: boolean): Promise<Task> {
    const task = await this.taskDatabaseService.findOneBy({ id });

    if (!task) {
      throw new EntityNotFoundException(Task);
    }

    if (isCompleted) {
      if (task.completedAt) {
        return task;
      }

      task.completedAt = new Date();

      return this.taskDatabaseService.save(task);
    }

    if (task.completedAt === null) {
      return task;
    }

    task.completedAt = null;

    return this.taskDatabaseService.save(task);
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
  async setOccurrenceCompleted(
    userId: string,
    taskId: string,
    originalStart: Date,
    completed: boolean,
  ): Promise<OccurrenceCompletionResult> {
    const task = await this.findById(userId, taskId);

    if (task.recurrenceRuleId === null) {
      const updated = await this.setCompleted(taskId, completed);

      return { completedAt: updated.completedAt, isOccurrenceScoped: false };
    }

    const exception = await this.taskOccurrenceExceptionService.upsertOverride(
      taskId,
      originalStart,
      { completedAt: completed ? new Date() : null },
    );

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
  async applyOccurrenceOverride(
    userId: string,
    taskId: string,
    originalStart: Date,
    changes: OccurrenceOverrideChanges,
  ): Promise<void> {
    const task = await this.findById(userId, taskId);

    if (task.recurrenceRuleId === null) {
      await this.collapseOverrideToMaster(userId, taskId, changes);

      return;
    }

    if (this.isOverrideMutation(changes)) {
      await this.ensureGeneratedOccurrence(task, originalStart);
    }

    await this.taskOccurrenceExceptionService.upsertOverride(
      taskId,
      originalStart,
      changes,
    );
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
   * Loads a single Task by id WITH its `recurrenceRule` relation hydrated and
   * asserts ownership. Plain `findById` (a relation-less `findOneBy`) leaves
   * `recurrenceRule` undefined for a real recurring task; callers that read the
   * rule off the row (the series-split path) must use this instead.
   * Throws 404 when the task is missing, 403 when owned by another user.
   */
  async findByIdWithRule(userId: string, taskId: string): Promise<Task> {
    const task = await this.taskDatabaseService.findOne({
      where: { id: taskId },
      relations: { recurrenceRule: true },
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
   */
  async update(
    userId: string,
    taskId: string,
    input: UpdateTaskInput,
  ): Promise<Task> {
    const task = await this.findById(userId, taskId);

    const nextStartAt = this.resolveNextDate(input.startAt, task.startAt);
    const nextEndAt = this.resolveNextDate(input.endAt, task.endAt);

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
    const nextRequiresCompletion =
      input.requiresCompletion ?? task.requiresCompletion;

    if (
      input.groupId !== undefined &&
      input.groupId !== null &&
      input.groupId !== task.groupId
    ) {
      await this.ensureGroupInCalendar(input.groupId, task.calendarId);
    }

    const recurrenceChanged = await this.applyRecurrenceUpdate(task, input);

    const hasFieldChanges =
      nextTitle !== task.title ||
      nextNotes !== task.notes ||
      nextGroupId !== task.groupId ||
      nextIsAllDay !== task.isAllDay ||
      nextRequiresCompletion !== task.requiresCompletion ||
      nextStartAt?.getTime() !== task.startAt?.getTime() ||
      nextEndAt?.getTime() !== task.endAt?.getTime();

    if (!hasFieldChanges) {
      return recurrenceChanged ? this.taskDatabaseService.save(task) : task;
    }

    task.title = nextTitle;
    task.notes = nextNotes;
    task.groupId = nextGroupId;
    task.isAllDay = nextIsAllDay;
    task.requiresCompletion = nextRequiresCompletion;
    task.startAt = nextStartAt;
    task.endAt = nextEndAt;

    return this.taskDatabaseService.save(task);
  }

  /**
   * Splits a series at `originalStart` (the "this and following" scope): ends the
   * existing rule the day before `originalStart`, then creates a new `Task` + new
   * `RecurrenceRule` (the old rule cloned with `changes.recurrence` merged)
   * anchored at `originalStart`. Exceptions dated `>= originalStart` are copied
   * onto the new task. Returns the newly created series-master task.
   *
   * The anchor is loaded WITH its `recurrenceRule` relation (plain `findById`
   * does not hydrate it), so a real recurring series — whose `recurrenceRule` is
   * `undefined` until eagerly loaded — splits correctly instead of throwing.
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
  async splitSeries(
    userId: string,
    taskId: string,
    originalStart: Date,
    changes: SplitSeriesChanges,
  ): Promise<Task> {
    const task = await this.findByIdWithRule(userId, taskId);

    if (task.recurrenceRuleId === null || task.recurrenceRule == null) {
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

    const oldRule = task.recurrenceRule;
    const recurrenceForNewRule = this.resolveSplitRecurrence(
      task,
      oldRule,
      originalStart,
      changes.recurrence,
    );

    await this.recurrenceRuleService.update(oldRule.id, {
      endType: RecurrenceEndType.UNTIL_DATE,
      endDate: this.dayBefore(originalStart, task.timezone),
    });

    const newRule =
      await this.recurrenceRuleService.create(recurrenceForNewRule);

    const durationMillis =
      task.startAt && task.endAt
        ? task.endAt.getTime() - task.startAt.getTime()
        : null;
    const newStartAt = changes.startAt
      ? new Date(changes.startAt)
      : originalStart;
    const newEndAt = this.resolveSplitEndAt(
      changes.endAt,
      newStartAt,
      durationMillis,
    );

    const newTask = this.taskDatabaseService.createInstance({
      calendarId: task.calendarId,
      groupId: changes.groupId !== undefined ? changes.groupId : task.groupId,
      title: changes.title ?? task.title,
      notes: changes.notes !== undefined ? changes.notes : task.notes,
      startAt: newStartAt,
      endAt: newEndAt,
      isAllDay: task.isAllDay,
      timezone: task.timezone,
      requiresCompletion: task.requiresCompletion,
      notificationStrategyId: task.notificationStrategyId,
      recurrenceRuleId: newRule.id,
    });

    const savedTask = await this.taskDatabaseService.save(newTask);

    await this.copyExceptionsFrom(taskId, savedTask.id, originalStart);

    return savedTask;
  }

  /**
   * Soft-deletes a Task by id after asserting ownership. Persists `deletedAt`
   * via `.save()` (per the repo's save-only convention); subsequent finds
   * exclude it by default.
   */
  async remove(userId: string, taskId: string): Promise<void> {
    const task = await this.findById(userId, taskId);

    task.deletedAt = new Date();

    await this.taskDatabaseService.save(task);
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
   *   rule to truncate.
   *
   * Loads the anchor WITH its `recurrenceRule` relation (plain `findById` does
   * not hydrate it). Validates ownership first.
   */
  async endSeriesAt(
    userId: string,
    taskId: string,
    originalStart: Date,
  ): Promise<void> {
    const task = await this.findByIdWithRule(userId, taskId);

    if (task.recurrenceRuleId === null || task.recurrenceRule == null) {
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

    await this.recurrenceRuleService.update(task.recurrenceRule.id, {
      endType: RecurrenceEndType.UNTIL_DATE,
      endDate: this.dayBefore(originalStart, task.timezone),
    });
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
        recurrenceRuleId: IsNull(),
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
        recurrenceRuleId: IsNull(),
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
    return task.startAt !== null && task.group?.defaultRecurrenceRuleId != null;
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
        recurrenceRuleId: IsNull(),
        startAt: LessThan(to),
        endAt: MoreThan(from),
        ...groupScope,
      },
      relations: { group: true },
    });
    const timedNoEnd = await this.taskDatabaseService.findAll({
      where: {
        calendarId: calendarScope,
        recurrenceRuleId: IsNull(),
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
    const todos = await this.taskDatabaseService.findAll({
      where: {
        calendarId: calendarScope,
        recurrenceRuleId: IsNull(),
        startAt: IsNull(),
        ...groupScope,
      },
    });

    return [...occurrences, ...todos.map((task) => this.wrapOneOff(task))];
  }

  /**
   * Loads every recurring anchor in scope (with its rule relation and group
   * relation for inheritance) and expands each into `[from, to)`, loading
   * per-anchor exceptions on demand.
   *
   * A task is a recurring anchor when EITHER it has its own `recurrenceRuleId`
   * OR its group carries a `defaultRecurrenceRuleId` (group inheritance). The
   * effective rule is resolved as `task.recurrenceRule ?? task.group.defaultRecurrenceRule`.
   */
  private async readRecurringOccurrences(
    calendarIds: string[],
    from: Date,
    to: Date,
    groupId?: string,
  ): Promise<Occurrence[]> {
    // Own-rule anchors: tasks with their own recurrenceRuleId set.
    const ownRuleAnchors = await this.taskDatabaseService.findAll({
      where: {
        calendarId: In(calendarIds),
        recurrenceRuleId: Not(IsNull()),
        ...(groupId ? { groupId } : {}),
      },
      relations: { recurrenceRule: true },
    });

    // Group-inherited anchors: tasks with NO own rule but assigned to a group
    // that has a defaultRecurrenceRuleId. Load both the group and its rule.
    const groupInheritedAnchors = await this.taskDatabaseService.findAll({
      where: {
        calendarId: In(calendarIds),
        recurrenceRuleId: IsNull(),
        groupId: Not(IsNull()),
        ...(groupId ? { groupId } : {}),
      },
      relations: { group: { defaultRecurrenceRule: true } },
    });

    const occurrences: Occurrence[] = [];

    for (const anchor of ownRuleAnchors) {
      if (!anchor.recurrenceRule) continue;

      const exceptions = await this.taskOccurrenceExceptionService.findForTask(
        anchor.id,
      );

      occurrences.push(
        ...this.recurrenceRuleService.expandOccurrences(
          anchor,
          anchor.recurrenceRule,
          exceptions,
          from,
          to,
        ),
      );
    }

    for (const anchor of groupInheritedAnchors) {
      const inheritedRule = anchor.group?.defaultRecurrenceRule ?? null;

      if (!inheritedRule) continue;

      const exceptions = await this.taskOccurrenceExceptionService.findForTask(
        anchor.id,
      );

      occurrences.push(
        ...this.recurrenceRuleService.expandOccurrences(
          anchor,
          inheritedRule,
          exceptions,
          from,
          to,
        ),
      );
    }

    return occurrences;
  }

  /**
   * Loads recurring anchors in a calendar and returns those with at least one
   * non-completed occurrence intersecting the bounded window. Includes both tasks
   * with their own rule and tasks inheriting a rule from their group. The expander
   * already window-clips to intersection (skipped occurrences are dropped by the
   * engine), so any in-window occurrence is, by construction, a clash — except a
   * per-instance-completed one, which is a finished item rather than a live
   * conflict and is filtered out here (mirroring `findOccurrencesInRange`).
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
        recurrenceRuleId: Not(IsNull()),
        ...excludeScope,
      },
      relations: { recurrenceRule: true },
    });

    const groupInheritedAnchors = await this.taskDatabaseService.findAll({
      where: {
        calendarId,
        recurrenceRuleId: IsNull(),
        groupId: Not(IsNull()),
        ...excludeScope,
      },
      relations: { group: { defaultRecurrenceRule: true } },
    });

    const clashing: Task[] = [];

    const checkAnchor = async (
      anchor: Task,
      effectiveRule: RecurrenceRule,
    ): Promise<void> => {
      const exceptions = await this.taskOccurrenceExceptionService.findForTask(
        anchor.id,
      );
      const occurrences = this.recurrenceRuleService.expandOccurrences(
        anchor,
        effectiveRule,
        exceptions,
        startAt,
        endAt,
      );

      const hasLiveOccurrence = occurrences.some(
        (occurrence) => occurrence.completedAt === null,
      );

      if (hasLiveOccurrence) {
        clashing.push(anchor);
      }
    };

    for (const anchor of ownRuleAnchors) {
      if (!anchor.recurrenceRule) continue;

      await checkAnchor(anchor, anchor.recurrenceRule);
    }

    for (const anchor of groupInheritedAnchors) {
      const inheritedRule = anchor.group?.defaultRecurrenceRule ?? null;

      if (!inheritedRule) continue;

      await checkAnchor(anchor, inheritedRule);
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
    };
  }

  /**
   * Applies the recurrence portion of an update to the master: removes the rule
   * when `recurrence` is explicitly null, updates it in place when one exists, or
   * creates and links a fresh rule otherwise. Returns whether the task's
   * `recurrenceRuleId` link changed (a rule field-only update does not).
   */
  private async applyRecurrenceUpdate(
    task: Task,
    input: UpdateTaskInput,
  ): Promise<boolean> {
    if (input.recurrence === undefined) return false;

    if (input.recurrence === null) {
      if (task.recurrenceRuleId === null) return false;

      const oldRuleId = task.recurrenceRuleId;

      task.recurrenceRuleId = null;
      await this.recurrenceRuleService.remove(oldRuleId);

      return true;
    }

    if (task.recurrenceRuleId !== null) {
      await this.recurrenceRuleService.update(
        task.recurrenceRuleId,
        input.recurrence,
      );

      return false;
    }

    const rule = await this.recurrenceRuleService.create(input.recurrence);

    task.recurrenceRuleId = rule.id;

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
      await this.setCompleted(taskId, changes.completedAt !== null);
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
   * recurrence engine and matching the generated `originalStart`. Loads the rule
   * through the `recurrenceRule` relation; throws when the rule is missing or no
   * occurrence lands on the coordinate ("not an occurrence of this series"),
   * preventing a phantom inert exception row. The window is deliberately bounded
   * to a single instant so expansion stays cheap.
   */
  private async ensureGeneratedOccurrence(
    task: Task,
    originalStart: Date,
  ): Promise<void> {
    const anchor = await this.taskDatabaseService.findOne({
      where: { id: task.id },
      relations: { recurrenceRule: true },
    });

    if (!anchor || !anchor.recurrenceRule) {
      throw new BadRequestException(
        'originalStart is not an occurrence of this series',
      );
    }

    // Membership is a property of the rule, not of current overrides — expand
    // with NO exceptions so a pre-existing skip/override on this coordinate does
    // not hide the (otherwise valid) occurrence from the match.
    const originalStartMillis = originalStart.getTime();
    const occurrences = this.recurrenceRuleService.expandOccurrences(
      anchor,
      anchor.recurrenceRule,
      [],
      new Date(originalStartMillis - 1),
      new Date(originalStartMillis + 1),
    );

    const isGenerated = occurrences.some(
      (occurrence) =>
        occurrence.originalStart?.getTime() === originalStartMillis,
    );

    if (!isGenerated) {
      throw new BadRequestException(
        'originalStart is not an occurrence of this series',
      );
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
   * Builds the recurrence DTO for the new (post-split) series: the old rule
   * cloned, then any `changes.recurrence` overlaid. For a `COUNT` old rule with
   * no explicit `count` override, the new side's `count` is recomputed so the
   * combined old + new total equals the ORIGINAL count exactly — see
   * `countOccurrencesBefore`. `UNTIL_DATE` / `NEVER` rules need no recount.
   */
  private resolveSplitRecurrence(
    task: Task,
    oldRule: RecurrenceRule,
    originalStart: Date,
    overrides?: CreateRecurrenceRuleDto,
  ): CreateRecurrenceRuleDto {
    const cloned = this.cloneRuleAsCreateDto(oldRule, overrides);

    const isCountRule =
      oldRule.endType === RecurrenceEndType.COUNT && oldRule.count !== null;
    const overridesCount = overrides?.count !== undefined;

    if (!isCountRule || overridesCount) return cloned;

    const occurrencesBefore = this.countOccurrencesBefore(
      task,
      oldRule,
      originalStart,
    );

    return {
      ...cloned,
      count: Math.max(0, (oldRule.count as number) - occurrencesBefore),
    };
  }

  /**
   * Counts how many occurrences the ORIGINAL rule generates in the half-open
   * window `[seriesStart, originalStart)` — i.e. strictly before the split
   * boundary. Expansion runs with NO exceptions (membership is a property of the
   * rule, not of overrides) over a window that starts 1ms before the anchor so
   * the very first occurrence is never dropped by the intersection clip. Used to
   * recompute the new side's `count` on a COUNT split.
   */
  private countOccurrencesBefore(
    task: Task,
    oldRule: RecurrenceRule,
    originalStart: Date,
  ): number {
    if (!task.startAt) return 0;

    const windowFrom = new Date(task.startAt.getTime() - 1);

    return this.recurrenceRuleService.expandOccurrences(
      task,
      oldRule,
      [],
      windowFrom,
      originalStart,
    ).length;
  }

  /**
   * Builds a `CreateRecurrenceRuleDto` from an existing rule, then overlays any
   * provided recurrence changes (used to clone the old rule for the new series).
   */
  private cloneRuleAsCreateDto(
    rule: RecurrenceRule,
    changes?: CreateRecurrenceRuleDto,
  ): CreateRecurrenceRuleDto {
    const base: CreateRecurrenceRuleDto = {
      frequency: rule.frequency,
      interval: rule.interval,
      byWeekday: rule.byWeekday ?? undefined,
      byMonthDay: rule.byMonthDay ?? undefined,
      byMonth: rule.byMonth ?? undefined,
      endType: rule.endType,
      endDate: rule.endDate ?? undefined,
      count: rule.count ?? undefined,
    };

    return { ...base, ...(changes ?? {}) };
  }

  /**
   * Resolves the new anchor's `endAt` for a split: an explicit value wins, else
   * the cloned anchor preserves the original duration, else null.
   */
  private resolveSplitEndAt(
    explicitEndAt: string | null | undefined,
    newStartAt: Date,
    durationMillis: number | null,
  ): Date | null {
    if (explicitEndAt !== undefined) {
      return explicitEndAt ? new Date(explicitEndAt) : null;
    }

    if (durationMillis === null) return null;

    return new Date(newStartAt.getTime() + durationMillis);
  }

  /**
   * Resolves a "next" date from an optional ISO input: a string parses to a
   * `Date`, an explicit null clears, and `undefined` keeps the current value.
   */
  private resolveNextDate(
    input: string | null | undefined,
    current: Date | null,
  ): Date | null {
    if (input === undefined) return current;

    return input ? new Date(input) : null;
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
