import { Injectable, Logger } from '@nestjs/common';
import { DateTime } from 'luxon';
import { ZodError } from 'zod';

import { ToolDispatchContext, ToolDispatchOutcome } from '../assistant.types';
import { formatTaskLine } from '../event-formatting';
import { ScheduleReaderService } from '../schedule-reader.service';
import { HandleMap, HandleTarget } from './handle-map';
import { ToolRegistry, toolRegistry } from './tool-registry';
import {
  RecurrenceInput,
  askUserInputSchema,
  checkAvailabilityInputSchema,
  completeTaskInputSchema,
  createGroupInputSchema,
  createTaskInputSchema,
  createTasksInputSchema,
  deleteTaskInputSchema,
  findFreeSlotsInputSchema,
  listGroupsInputSchema,
  listTasksInputSchema,
  setReminderInputSchema,
  updateGroupInputSchema,
  updateTaskInputSchema,
} from './tool-schemas';
import { ToolHandlerHost } from './tool.contract';
import { ToolCall } from '@/modules/ai/ai.types';
import { CalendarService } from '@/modules/calendar/calendar.service';
import {
  ConflictPolicy,
  Task,
  TaskOccurrenceException,
} from '@/modules/database/entities';
import { CreateRecurrenceRuleDto } from '@/modules/recurrence-rule/dtos';
import {
  RecurringSeriesConflicts,
  TaskService,
} from '@/modules/task/task.service';
import { TaskGroupService } from '@/modules/task-group/task-group.service';
import { OccurrenceOverrideChanges } from '@/modules/task-occurrence-exception/task-occurrence-exception.service';

/** Maximum free slots returned by `find_free_slots` to keep results compact. */
const MAX_FREE_SLOTS = 5;

/**
 * Maximum rendered lines `list_tasks` / `list_groups` return before truncating.
 * A long agenda dump bloats the model's context (and the audit row) for little
 * gain — past this the model should narrow the range or filter by group, so the
 * dispatcher slices to this many and appends a "+N more" hint.
 */
const MAX_LIST_LINES = 40;

/** Default range when `list_tasks` is called without `from`/`to` (today → +7d). */
const DEFAULT_LIST_DAYS = 7;

/** Recoverable result when a handle resolves to nothing in the current turn. */
const STALE_HANDLE_RESULT: ToolDispatchOutcome = {
  content: "That reference isn't in view — list the day again to refresh it.",
  isError: true,
};

/**
 * Recoverable result asking the model to pick a recurring-edit scope. The model
 * asks the user one concise question and re-issues with `editScope`.
 */
const ASK_EDIT_SCOPE_RESULT: ToolDispatchOutcome = {
  content:
    'This is a repeating task. Apply to just this one, this and future, or all? Re-issue with editScope ("this" | "this_and_following" | "all").',
  isError: true,
};

/**
 * The default-deny instruction appended to EVERY conflict tool-result (ADR 0011).
 * Stated on the wire — not only in the system prompt — so the model is reminded,
 * at the exact point of the clash, that it must NOT book over an existing
 * commitment without explicit user authorization.
 */
const DEFAULT_DENY_INSTRUCTION =
  'Do NOT book over it unless the user explicitly authorized this. If they did, retry this same call with confirmOverlap:true; otherwise call ask_user to get their decision first.';

/**
 * Recoverable result returned when the user has a standing `conflict_policy` of
 * `DENY` (Story 15 / ADR 0011 + 0044) and a write clashes: it OVERRIDES any
 * `confirmOverlap` the model set, so a deny policy can never be booked over. The
 * model relays this and offers a non-overlapping alternative — it does NOT ask
 * (the user's standing answer is already "no").
 */
const buildDenyPolicyResult = (conflicts: Task[]): ToolDispatchOutcome => {
  const titles = conflicts.map((task) => `"${task.title}"`).join(', ');
  const clause = titles ? ` (${titles})` : '';

  return {
    content: `That overlaps an existing commitment${clause} and the user's standing policy refuses overlaps. Do NOT book over it (confirmOverlap is ignored under this policy); offer a non-overlapping time instead.`,
    isError: true,
  };
};

/**
 * Recoverable result returned when the model tries to DELETE/remove an existing
 * commitment without explicit in-message confirmation (Story 15 / ADR 0011 +
 * 0044). A delete is destructive and irreversible, so it ALWAYS asks first —
 * neither `confirmOverlap` nor a standing allow-policy authorizes it; only an
 * explicit `confirmDelete` (set after the user confirmed THIS delete) does.
 */
const ASK_BEFORE_DELETE_RESULT: ToolDispatchOutcome = {
  content:
    'Deleting is destructive and cannot be undone — ask the user to confirm removing this specific item first (call ask_user). Only once they confirm, retry with confirmDelete:true. confirmOverlap and a standing allow-policy do NOT authorize a delete.',
  isError: true,
};

/**
 * Builds the recoverable, default-deny conflict tool-result text (ADR 0011) for a
 * one-off timed overlap: it RESTATES the specific clashing commitments by title
 * and appends the default-deny instruction. Returned as an `isError` outcome (NOT
 * thrown, NOT a hold), so the model recovers — asking the user or, when already
 * authorized, retrying with `confirmOverlap`.
 */
const buildConflictResult = (conflicts: Task[]): ToolDispatchOutcome => {
  const titles = conflicts.map((task) => `"${task.title}"`).join(', ');

  return {
    content: `That overlaps an existing commitment (${titles}). ${DEFAULT_DENY_INSTRUCTION}`,
    isError: true,
  };
};

/**
 * Builds the recoverable, default-deny conflict tool-result text (ADR 0011) for a
 * recurring SERIES whose occurrences overlap existing events: it reports the
 * distinct clashing-date count + a few clashing titles and appends the
 * default-deny instruction. Same recoverable `isError` posture as the one-off
 * conflict — never a hold.
 */
const buildSeriesConflictResult = (
  seriesConflicts: RecurringSeriesConflicts,
): ToolDispatchOutcome => {
  const dateCount = seriesConflicts.conflictDates.length;
  const dateLabel = dateCount === 1 ? '1 date' : `${dateCount} dates`;
  const titles = seriesConflicts.conflictingTasks
    .map((task) => `"${task.title}"`)
    .join(', ');

  return {
    content: `This repeating task overlaps existing commitments on ${dateLabel}${
      titles ? ` (${titles})` : ''
    }. ${DEFAULT_DENY_INSTRUCTION}`,
    isError: true,
  };
};

/**
 * Result of resolving a group name: a concrete id, or a recoverable
 * `ToolDispatchOutcome` the model relays (ambiguous / missing). The dispatcher
 * branches on which field is present.
 */
interface GroupResolution {
  groupId?: string;
  outcome?: ToolDispatchOutcome;
}

/**
 * Result of resolving the `group` argument of an UPDATE into the tri-state the
 * task service expects. Exactly one of `groupId` / `outcome` is set: `groupId`
 * is the resolved tri-state value (`undefined` ⇒ leave unchanged, `null` ⇒
 * un-group, a string ⇒ the resolved id), `outcome` a recoverable result the model
 * relays (ambiguous / missing name). The caller forwards `groupId` only when the
 * `group` key was present, so an omitted key never arrives as a null un-group.
 */
interface GroupUpdateResolution {
  groupId?: string | null;
  outcome?: ToolDispatchOutcome;
}

/** A validated, parsed single-create input (shared by `create_task[s]`). */
type CreateTaskInput = ReturnType<typeof createTaskInputSchema.parse>;

/**
 * Outcome of attempting one create (shared between `create_task` and the
 * `create_tasks` fan-out). Exactly one field is set: `created` (committed, with
 * its title) or `error` (a recoverable outcome the model relays — a missing
 * calendar / group, or an unauthorized overlap refused under default-deny, ADR
 * 0011). The dispatcher branches on which is present.
 */
interface CreateAttempt {
  created?: { title: string };
  error?: ToolDispatchOutcome;
}

/**
 * Translates a model {@link ToolCall} into a call on an existing feature service
 * (TaskService / TaskGroupService / CalendarService) and returns a normalized
 * {@link ToolDispatchOutcome}. It never touches repositories or entities
 * directly and never re-invokes the model. A write that would overlap an existing
 * commitment is REFUSED under a strict default-deny posture (ADR 0011 + 0044):
 * instead of executing, the dispatcher returns a recoverable `isError` tool result
 * that restates the clash and the default-deny rule, so the model asks the user
 * (or, when the user already authorized it, retries with `confirmOverlap`). The
 * user's STANDING `conflict_policy` (threaded on the context) tilts the gate: an
 * `ALLOW` policy proceeds over an overlap WITHOUT asking (as if `confirmOverlap`),
 * a `DENY` policy refuses every overlap even when `confirmOverlap` is set. A
 * DESTRUCTIVE delete (it removes an existing commitment) ALWAYS asks first — gated
 * behind an explicit `confirmDelete`; neither `confirmOverlap` nor an allow-policy
 * authorizes it. Mutations address tasks by a per-turn handle the
 * {@link HandleMap} resolves to a `(taskId, originalStart)` coordinate; raw task
 * ids never cross the model boundary.
 */
@Injectable()
export class ToolDispatcherService implements ToolHandlerHost {
  private readonly logger = new Logger(ToolDispatcherService.name);

  private readonly registry: ToolRegistry;

  constructor(
    private readonly taskService: TaskService,
    private readonly taskGroupService: TaskGroupService,
    private readonly calendarService: CalendarService,
    private readonly scheduleReader: ScheduleReaderService,
  ) {
    this.registry = toolRegistry;
  }

  /**
   * True when a standing `DENY` conflict policy is in force (Story 15 / ADR 0011 +
   * 0044): under it the overlap gate runs REGARDLESS of `confirmOverlap` and a
   * clash is refused outright — the deny policy overrides any in-message
   * authorization, so the model can never book over it.
   */
  private isOverlapDenied(context: ToolDispatchContext): boolean {
    return context.conflictPolicy === ConflictPolicy.DENY;
  }

  /**
   * True when a write may proceed over an overlap WITHOUT the default-deny gate
   * refusing it (Story 15 / ADR 0011 + 0044): either the model set `confirmOverlap`
   * (the user authorized THIS booking in their message) or the user has a standing
   * `ALLOW` policy (they opted in once and for all). A `DENY` policy is handled
   * earlier and never reaches an "authorized" verdict; absent any policy this
   * falls back to the in-message flag alone (pure default-deny).
   */
  private isOverlapAuthorized(
    confirmOverlap: boolean | undefined,
    context: ToolDispatchContext,
  ): boolean {
    if (this.isOverlapDenied(context)) return false;

    return (
      confirmOverlap === true || context.conflictPolicy === ConflictPolicy.ALLOW
    );
  }

  /**
   * Builds an error tool outcome from a thrown value without leaking a raw stack
   * trace to the model (it gets a short, recoverable message). A Zod validation
   * failure (e.g. a `COUNT` recurrence missing `count`) is flattened to its
   * human-readable issue messages so the model can correct the offending input
   * rather than parsing raw Zod JSON.
   */
  private toErrorOutcome(
    error: unknown,
    correlationId?: string,
  ): ToolDispatchOutcome {
    const message = this.describeError(error);

    this.logger.warn(
      `[cid=${correlationId ?? 'none'}] Tool dispatch failed: ${message}`,
    );

    return { content: `Error: ${message}`, isError: true };
  }

  /**
   * Reduces a thrown value to a short, model-actionable message: the joined Zod
   * issue messages for a validation failure, the `Error.message` otherwise.
   */
  private describeError(error: unknown): string {
    if (error instanceof ZodError) {
      return error.issues.map((issue) => issue.message).join('; ');
    }

    return error instanceof Error ? error.message : 'unknown error';
  }

  /**
   * Returns the turn's {@link HandleMap}, or a fresh empty one as a fallback when
   * the orchestrator has not yet seeded one (pre-A2). The fallback only spans the
   * current dispatch call.
   */
  private handleMapOf(context: ToolDispatchContext): HandleMap {
    return context.handleMap ?? new HandleMap();
  }

  /**
   * Maps a validated `recurrence` input to the `CreateRecurrenceRuleDto` the task
   * service consumes. The Zod shape already mirrors the DTO field-for-field, so
   * this is a structural pass-through that satisfies the DTO's nominal type.
   */
  private toRecurrenceDto(
    recurrence: RecurrenceInput,
  ): CreateRecurrenceRuleDto {
    return {
      frequency: recurrence.frequency,
      interval: recurrence.interval,
      byWeekday: recurrence.byWeekday,
      byMonthDay: recurrence.byMonthDay,
      byMonth: recurrence.byMonth,
      endType: recurrence.endType,
      endDate: recurrence.endDate,
      count: recurrence.count,
    };
  }

  /**
   * Resolves a group name to a single owned group id, or to a recoverable
   * outcome the model relays. Zero matches ⇒ confirm/`create_group`; more than
   * one ⇒ clarify; exactly one ⇒ its id. Never auto-creates.
   */
  private async resolveGroup(
    userId: string,
    name: string,
  ): Promise<GroupResolution> {
    const matches = await this.taskGroupService.findByName(userId, name);

    if (matches.length === 0) {
      return {
        outcome: {
          content: `There is no group named "${name}". Confirm with the user, then use create_group to make it.`,
          isError: true,
        },
      };
    }

    if (matches.length > 1) {
      return {
        outcome: {
          content: `More than one group is named "${name}". Ask the user which one they mean.`,
          isError: true,
        },
      };
    }

    return { groupId: matches[0].id };
  }

  /**
   * Resolves an UPDATE's `group` argument into the tri-state `groupId` the task
   * service expects, honoring set-vs-clear: an omitted key (`undefined`) leaves
   * the group unchanged; an explicit `null` un-groups the task (forwarded straight
   * as `groupId: null`, bypassing `resolveGroup`); a name string is resolved to a
   * single owned group id (surfacing the ambiguous / missing recoverable outcome).
   * Centralizes the branch so the one-off, `all`, and `this_and_following` paths
   * thread the identical tri-state.
   */
  private async resolveGroupUpdate(
    userId: string,
    group: string | null | undefined,
  ): Promise<GroupUpdateResolution> {
    if (group === undefined) return {};
    if (group === null) return { groupId: null };

    const resolution = await this.resolveGroup(userId, group);

    if (resolution.outcome) return { outcome: resolution.outcome };

    return { groupId: resolution.groupId };
  }

  /**
   * Resolves the calendar a write targets: an explicit `calendarId`, else the
   * user's primary calendar. Returns null when none is available.
   */
  private async resolveCalendarId(
    userId: string,
    calendarId?: string,
  ): Promise<string | null> {
    if (calendarId) return calendarId;

    const primary = await this.calendarService.findPrimaryForOwner(userId);

    return primary?.id ?? null;
  }

  /**
   * Handles `list_tasks`: fetches the occurrences for the (optionally
   * group-scoped) range, seeds each into the turn's handle map, and renders one
   * aliased line per occurrence. Counts against the schedule-fetch read cap.
   */
  async handleListTasks(
    input: Record<string, unknown>,
    context: ToolDispatchContext,
  ): Promise<ToolDispatchOutcome> {
    const parsed = listTasksInputSchema.parse(input);
    const from = parsed.from ? new Date(parsed.from) : new Date();
    const to = parsed.to
      ? new Date(parsed.to)
      : new Date(from.getTime() + DEFAULT_LIST_DAYS * 86_400_000);

    let groupId: string | undefined;

    if (parsed.group) {
      const resolution = await this.resolveGroup(context.userId, parsed.group);

      if (resolution.outcome) return resolution.outcome;

      groupId = resolution.groupId;
    }

    const occurrences = await this.scheduleReader.occurrencesInRange(
      context.userId,
      from,
      to,
      {
        groupId,
        includeCompleted: parsed.includeCompleted,
        includeTodos: parsed.onlyTodos,
      },
    );

    const filtered = parsed.onlyTodos
      ? occurrences.filter((occurrence) => occurrence.occurrenceStart === null)
      : occurrences;

    if (filtered.length === 0) {
      return {
        content: 'No tasks in that range.',
        countsAsScheduleFetch: true,
      };
    }

    const handleMap = this.handleMapOf(context);
    // Slice BEFORE rendering so handles are only minted for the lines the model
    // actually sees — seeding aliases for hidden occurrences would let the model
    // reference a task it was never shown.
    const overflow = filtered.length - MAX_LIST_LINES;
    const shown = overflow > 0 ? filtered.slice(0, MAX_LIST_LINES) : filtered;
    const lines = shown.map((occurrence) =>
      formatTaskLine(
        occurrence,
        context.user.timezone,
        handleMap.addOccurrence(occurrence),
      ),
    );

    if (overflow > 0) {
      lines.push(`(+${overflow} more — narrow the range or filter by group)`);
    }

    return { content: lines.join('\n'), countsAsScheduleFetch: true };
  }

  /**
   * Handles `find_free_slots`: walks the busy occurrences (those with a concrete
   * start+end) in range and returns the gaps of at least `durationMinutes`.
   * Counts against the schedule-fetch cap.
   */
  async handleFindFreeSlots(
    input: Record<string, unknown>,
    context: ToolDispatchContext,
  ): Promise<ToolDispatchOutcome> {
    const parsed = findFreeSlotsInputSchema.parse(input);
    const rangeStart = new Date(parsed.from);
    const rangeEnd = new Date(parsed.to);
    const durationMs = parsed.durationMinutes * 60_000;

    const busy = (
      await this.scheduleReader.occurrencesInRange(
        context.userId,
        rangeStart,
        rangeEnd,
        { calendarId: parsed.calendarId },
      )
    ).filter(
      (occurrence) =>
        occurrence.occurrenceStart !== null &&
        occurrence.occurrenceEnd !== null,
    );

    const slots: string[] = [];
    let cursor = rangeStart;

    for (const occurrence of busy) {
      const occurrenceStart = occurrence.occurrenceStart as Date;
      const occurrenceEnd = occurrence.occurrenceEnd as Date;

      if (occurrenceStart.getTime() - cursor.getTime() >= durationMs) {
        slots.push(
          this.formatSlot(cursor, occurrenceStart, context.user.timezone),
        );
      }

      if (occurrenceEnd.getTime() > cursor.getTime()) {
        cursor = occurrenceEnd;
      }

      if (slots.length >= MAX_FREE_SLOTS) {
        break;
      }
    }

    if (
      slots.length < MAX_FREE_SLOTS &&
      rangeEnd.getTime() - cursor.getTime() >= durationMs
    ) {
      slots.push(this.formatSlot(cursor, rangeEnd, context.user.timezone));
    }

    if (slots.length === 0) {
      return {
        content: 'No open slot of that length in the range.',
        countsAsScheduleFetch: true,
      };
    }

    return {
      content: `Free: ${slots.join('; ')}`,
      countsAsScheduleFetch: true,
    };
  }

  /**
   * Formats a free slot `start–end` in the user's timezone.
   */
  private formatSlot(start: Date, end: Date, timezone: string): string {
    const startText = DateTime.fromJSDate(start)
      .setZone(timezone)
      .toFormat('ccc dd LLL HH:mm');
    const endText = DateTime.fromJSDate(end)
      .setZone(timezone)
      .toFormat('HH:mm');

    return `${startText}–${endText}`;
  }

  /**
   * Handles `check_availability`: point-checks EACH proposed slot in input order
   * against existing events via the SAME conflict primitive the write-time hold
   * uses (`TaskService.findOverlapping`) — one call per slot with that slot's
   * exact bounds, never `findInRange` and never a single unioned window — so a
   * "free" verdict here and a later `create_task` can never disagree. Each
   * conflicting task is minted an `[eN]` handle (resolving to its row, since
   * `findOverlapping` returns master rows) so the model can act on it. A slot that
   * cannot be meaningfully point-checked (malformed / open-ended / a rule-shaped
   * proposal) yields a recoverable per-slot note rather than a false "FREE". It is
   * a schedule-fetch read (one batch call = one fetch), NEVER a write.
   */
  async handleCheckAvailability(
    input: Record<string, unknown>,
    context: ToolDispatchContext,
  ): Promise<ToolDispatchOutcome> {
    const parsed = checkAvailabilityInputSchema.parse(input);
    const handleMap = this.handleMapOf(context);
    const lines: string[] = [];

    for (const [index, slot] of parsed.slots.entries()) {
      const position = index + 1;
      const startAt = new Date(slot.startAt);
      const endAt = new Date(slot.endAt);

      // A slot that cannot be point-checked (unparseable / open-ended / a
      // rule-shaped proposal that collapses to a zero-or-negative window) is
      // reported honestly rather than scanned and falsely called FREE.
      if (!this.isCheckableWindow(startAt, endAt)) {
        lines.push(
          `Slot ${position}: SKIPPED — not a concrete future window; pass a valid startAt before endAt (a recurrence rule is not a slot).`,
        );
        continue;
      }

      const calendarId = await this.resolveCalendarId(
        context.userId,
        slot.calendarId,
      );

      if (!calendarId) {
        lines.push(
          `Slot ${position}: SKIPPED — no calendar available to check.`,
        );
        continue;
      }

      const conflicts = await this.taskService.findOverlapping(
        context.userId,
        calendarId,
        startAt,
        endAt,
        slot.excludeTaskId,
      );

      lines.push(
        this.formatSlotVerdict(
          position,
          startAt,
          endAt,
          conflicts,
          handleMap,
          context.user.timezone,
        ),
      );
    }

    return { content: lines.join('\n'), countsAsScheduleFetch: true };
  }

  /**
   * True when a proposed slot is a concrete, point-checkable window: both bounds
   * parse to real dates and `endAt` is strictly after `startAt`. A NaN bound (an
   * unparseable / rule-shaped value) or a zero-length / inverted window is not
   * checkable — the caller reports it as a per-slot note instead of probing it.
   */
  private isCheckableWindow(startAt: Date, endAt: Date): boolean {
    if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime())) {
      return false;
    }

    return endAt.getTime() > startAt.getTime();
  }

  /**
   * Renders one slot's verdict: `FREE` when nothing overlaps, else `BUSY` with
   * each conflicting task tagged by a freshly-minted `[eN]` handle (resolving to
   * the task row — `findOverlapping` returns masters/one-offs, so `originalStart`
   * is null) plus its title. The proposed window is shown in the user's timezone
   * so the model and user can read which slot it is.
   */
  private formatSlotVerdict(
    position: number,
    startAt: Date,
    endAt: Date,
    conflicts: Task[],
    handleMap: HandleMap,
    timezone: string,
  ): string {
    const window = this.formatSlot(startAt, endAt, timezone);

    if (conflicts.length === 0) {
      return `Slot ${position} (${window}): FREE`;
    }

    const tagged = conflicts
      .map((task) => {
        const alias = handleMap.add({ taskId: task.id, originalStart: null });

        return `[${alias}] '${task.title}'`;
      })
      .join(', ');

    return `Slot ${position} (${window}): BUSY — ${tagged}`;
  }

  /**
   * Handles `create_task`: resolves the calendar / group / timezone and creates a
   * timed event, all-day event, or todo (optionally recurring). A timed task that
   * overlaps an existing commitment is REFUSED under default-deny (ADR 0011) —
   * {@link attemptCreate} returns a recoverable `isError` restating the clash —
   * unless the model set `confirmOverlap` (the user authorized it). Delegates the
   * per-item resolution + conflict logic to {@link attemptCreate}, the same helper
   * `create_tasks` fans out over, so the two never diverge.
   */
  async handleCreateTask(
    input: Record<string, unknown>,
    context: ToolDispatchContext,
  ): Promise<ToolDispatchOutcome> {
    const parsed = createTaskInputSchema.parse(input);
    const attempt = await this.attemptCreate(parsed, context);

    if (attempt.error) return attempt.error;

    return { content: `Created "${attempt.created?.title}".` };
  }

  /**
   * Handles `create_tasks`: fans out over the validated batch IN INPUT ORDER,
   * running the SAME per-item resolution + conflict logic as a single
   * `create_task` ({@link attemptCreate}). Non-conflicting items are created
   * immediately; an item that overlaps an existing commitment is REFUSED under
   * default-deny (ADR 0011) and reported in the per-item summary with its
   * recoverable restatement (the rest still commit — one overlap never aborts the
   * batch). Returns ONE outcome: a per-item summary as `content` plus
   * `committedCount` / `attemptedCount` so the orchestrator's write accounting is
   * exact. An over-cap array is rejected upstream by Zod (`.max`) as a recoverable
   * validation error, never reaching here.
   */
  async handleCreateTasks(
    input: Record<string, unknown>,
    context: ToolDispatchContext,
  ): Promise<ToolDispatchOutcome> {
    const parsed = createTasksInputSchema.parse(input);
    const summaries: string[] = [];
    let committedCount = 0;

    for (const [index, task] of parsed.tasks.entries()) {
      const position = index + 1;
      const attempt = await this.attemptCreate(task, context);

      if (attempt.error) {
        summaries.push(`${position}: refused (${attempt.error.content})`);
        continue;
      }

      committedCount += 1;
      summaries.push(`${position}: created "${attempt.created?.title}"`);
    }

    return {
      content: summaries.join('; '),
      // Every item is a write attempt (committed or refused) so the guard and the
      // saved-changes count stay accurate; only committed items count as committed.
      attemptedCount: parsed.tasks.length,
      committedCount,
    };
  }

  /**
   * Resolves the calendar / group / timezone for one create and either commits
   * it or refuses it under default-deny — the single source of create logic shared
   * by `create_task` and the `create_tasks` fan-out. A timed task with a concrete
   * window is conflict-checked; an overlap is REFUSED with a recoverable `isError`
   * restating the clash (ADR 0011) UNLESS the model set `confirmOverlap` (the user
   * authorized booking over it). A RECURRING timed create is conflict-checked
   * across its whole proposed series (Story 9): the rule is expanded over a bounded
   * horizon and any occurrence overlap refuses the WHOLE series the same way.
   * Non-conflicting (or explicitly authorized) creates commit. Returns a
   * {@link CreateAttempt} with exactly one of `error` / `created`.
   */
  private async attemptCreate(
    parsed: CreateTaskInput,
    context: ToolDispatchContext,
  ): Promise<CreateAttempt> {
    const calendarId = await this.resolveCalendarId(
      context.userId,
      parsed.calendarId,
    );

    if (!calendarId) {
      return {
        error: {
          content: 'Error: no calendar is available to create the task in.',
          isError: true,
        },
      };
    }

    let groupId: string | undefined;

    if (parsed.group) {
      const resolution = await this.resolveGroup(context.userId, parsed.group);

      if (resolution.outcome) return { error: resolution.outcome };

      groupId = resolution.groupId;
    }

    const timezone = parsed.timezone ?? context.user.timezone;
    const startAt = parsed.startAt ? new Date(parsed.startAt) : null;
    const endAt = parsed.endAt ? new Date(parsed.endAt) : null;

    // Default-deny conflict gate (ADR 0011 + 0044): a timed create is
    // conflict-checked and REFUSED on overlap with a recoverable restatement —
    // unless it is authorized (the model set `confirmOverlap` OR the user has a
    // standing ALLOW policy), in which case the check is SKIPPED so the write
    // commits. A standing DENY policy forces the check to run even when
    // `confirmOverlap` is set and refuses with the deny restatement (the deny
    // overrides the flag). The deny verdict is computed per-branch off the actual
    // clashing tasks.
    const denied = this.isOverlapDenied(context);

    if (
      !this.isOverlapAuthorized(parsed.confirmOverlap, context) &&
      startAt &&
      endAt
    ) {
      // A recurring create is checked across its whole proposed series; a one-off
      // against the single window. Either way a clash refuses, never books.
      if (parsed.recurrence) {
        const seriesConflicts =
          await this.taskService.findRecurringSeriesConflicts(
            context.userId,
            calendarId,
            {
              title: parsed.title,
              startAt,
              endAt,
              timezone,
              recurrence: this.toRecurrenceDto(parsed.recurrence),
            },
          );

        if (seriesConflicts.conflictDates.length > 0) {
          return denied
            ? {
                error: buildDenyPolicyResult(seriesConflicts.conflictingTasks),
              }
            : { error: buildSeriesConflictResult(seriesConflicts) };
        }
      } else {
        const conflicts = await this.taskService.findOverlapping(
          context.userId,
          calendarId,
          startAt,
          endAt,
        );

        if (conflicts.length > 0) {
          return denied
            ? { error: buildDenyPolicyResult(conflicts) }
            : { error: buildConflictResult(conflicts) };
        }
      }
    }

    const created = await this.taskService.create(context.userId, {
      calendarId,
      title: parsed.title,
      notes: parsed.notes,
      startAt: parsed.startAt,
      endAt: parsed.endAt,
      isAllDay: parsed.isAllDay,
      timezone,
      requiresCompletion: parsed.requiresCompletion,
      color: parsed.color,
      groupId,
      recurrence: parsed.recurrence
        ? this.toRecurrenceDto(parsed.recurrence)
        : undefined,
    });

    return { created: { title: created.title } };
  }

  /**
   * Handles `update_task`: resolves the handle, then dispatches by recurrence and
   * edit scope. A recurring target requires `editScope` (asks otherwise);
   * `this` → occurrence override, `this_and_following` → series split, `all` →
   * master update. A one-off ignores `editScope` and runs the default-deny
   * conflict gate (ADR 0011) on a timed move. A `this_and_following` / `all`
   * recurring edit that changes the time or rule is series-conflict-checked and
   * refused on overlap the same way (Story 9).
   */
  async handleUpdateTask(
    input: Record<string, unknown>,
    context: ToolDispatchContext,
  ): Promise<ToolDispatchOutcome> {
    const parsed = updateTaskInputSchema.parse(input);
    const target = this.handleMapOf(context).resolve(parsed.handle);

    if (!target) return STALE_HANDLE_RESULT;

    const task = await this.taskService.findById(context.userId, target.taskId);
    const isRecurringInstance =
      task.recurrenceConfig !== null && target.originalStart !== null;
    const recurrenceUpdate = this.resolveRecurrenceUpdate(parsed.recurrence);

    if (isRecurringInstance) {
      return this.updateRecurring(
        context,
        task,
        target,
        parsed,
        recurrenceUpdate,
      );
    }

    return this.updateOneOff(context, task, parsed, recurrenceUpdate);
  }

  /**
   * Maps a validated `recurrence` update input to the value the task service
   * expects: `undefined` (omitted ⇒ leave unchanged), `null` (clear recurrence),
   * or the `CreateRecurrenceRuleDto` (set/replace). Single-sourced so the
   * one-off, `all`, and `this_and_following` paths thread the same tri-state.
   */
  private resolveRecurrenceUpdate(
    recurrence: RecurrenceInput | null | undefined,
  ): CreateRecurrenceRuleDto | null | undefined {
    if (recurrence === undefined) return undefined;
    if (recurrence === null) return null;

    return this.toRecurrenceDto(recurrence);
  }

  /**
   * Applies a recurring update at the chosen scope. Absent scope asks the model
   * to choose. `this` overrides the single occurrence; `this_and_following`
   * splits the series; `all` updates the master (resolving an optional group
   * rename by name).
   *
   * A `this_and_following` or `all` edit that changes the time or rule is
   * conflict-checked across the effective post-edit series (Story 9): on any
   * occurrence overlap it is REFUSED under default-deny (ADR 0011) with a
   * recoverable restatement — unless the model set `confirmOverlap` — instead of
   * silently booking over existing events. The `this` scope retargets a single
   * occurrence; a move that changes its time runs the SAME default-deny gate as a
   * one-off move (ADR 0044) before overriding — so dropping one occurrence onto an
   * existing commitment is refused, and a standing DENY overrides `confirmOverlap`.
   */
  private async updateRecurring(
    context: ToolDispatchContext,
    task: Task,
    target: HandleTarget,
    parsed: ReturnType<typeof updateTaskInputSchema.parse>,
    recurrenceUpdate: CreateRecurrenceRuleDto | null | undefined,
  ): Promise<ToolDispatchOutcome> {
    const scope = parsed.editScope;

    if (!scope) return ASK_EDIT_SCOPE_RESULT;

    const userId = context.userId;
    const originalStart = target.originalStart as Date;
    // The split path can only ADD/replace a rule, not clear it (a split needs a
    // rule for the new series), so it consumes only the DTO form; `all` threads
    // the full tri-state through to the master update.
    const recurrenceDto =
      recurrenceUpdate === null ? undefined : recurrenceUpdate;

    if (scope === 'this') {
      // Read the occurrence's existing override (if any) ONCE. A prior length
      // change means the occurrence's true span differs from the master's, so
      // both the conflict gate and the persisted result must use that true span
      // — not the master duration — or a start-only move silently under-detects
      // a clash and strands the old end (resizing or even inverting the window).
      const existingException = await this.taskService.findOccurrenceException(
        userId,
        target.taskId,
        originalStart,
      );

      const moveConflict = await this.occurrenceMoveConflict(
        context,
        task,
        originalStart,
        parsed,
        existingException,
      );

      if (moveConflict) return moveConflict;

      await this.taskService.applyOccurrenceOverride(
        userId,
        target.taskId,
        originalStart,
        this.buildOccurrenceOverrideChanges(
          task,
          originalStart,
          parsed,
          existingException,
        ),
      );

      return { content: 'Updated this occurrence.' };
    }

    if (scope === 'this_and_following') {
      // Resolve the group BEFORE splitting: a name that is ambiguous or missing
      // must surface as a recoverable result without having mutated the series,
      // otherwise we would split and then report a partial / false success. The
      // tri-state is forwarded by KEY PRESENCE (`parsed.group !== undefined`) so an
      // explicit null un-groups the new series and an omitted key keeps the parent.
      const groupResolution = await this.resolveGroupUpdate(
        userId,
        parsed.group,
      );

      if (groupResolution.outcome) return groupResolution.outcome;

      const hasGroupChange = parsed.group !== undefined;
      const splitGroupId = groupResolution.groupId;

      const splitConflict = await this.recurringEditConflict(
        context,
        target.taskId,
        parsed,
        recurrenceDto,
      );

      if (splitConflict) return splitConflict;

      // The group is passed INTO the split so it is validated against the new
      // master's calendar and applied in the same insert — a cross-calendar
      // group is rejected before any write (no split-then-lost-group partial),
      // and there is no follow-up `update`.
      const newMaster = await this.taskService.splitSeries(
        userId,
        target.taskId,
        originalStart,
        {
          ...(parsed.title !== undefined ? { title: parsed.title } : {}),
          ...(parsed.startAt !== undefined ? { startAt: parsed.startAt } : {}),
          ...(parsed.endAt !== undefined ? { endAt: parsed.endAt } : {}),
          ...(parsed.notes !== undefined ? { notes: parsed.notes } : {}),
          ...(parsed.isAllDay !== undefined
            ? { isAllDay: parsed.isAllDay }
            : {}),
          ...(parsed.timezone !== undefined
            ? { timezone: parsed.timezone }
            : {}),
          ...(parsed.requiresCompletion !== undefined
            ? { requiresCompletion: parsed.requiresCompletion }
            : {}),
          ...(parsed.color !== undefined ? { color: parsed.color } : {}),
          ...(hasGroupChange ? { groupId: splitGroupId } : {}),
          ...(recurrenceDto ? { recurrence: recurrenceDto } : {}),
        },
      );

      // A move-to-group only happens when a NON-null group id was resolved; an
      // explicit un-group (null) reports the plain following-updated message.
      return splitGroupId
        ? {
            content: `Updated "${newMaster.title}" and following, and moved them to the group.`,
          }
        : { content: `Updated "${newMaster.title}" and following.` };
    }

    const groupResolution = await this.resolveGroupUpdate(userId, parsed.group);

    if (groupResolution.outcome) return groupResolution.outcome;

    const hasGroupChange = parsed.group !== undefined;
    const groupId = groupResolution.groupId;

    const allConflict = await this.recurringEditConflict(
      context,
      target.taskId,
      parsed,
      recurrenceDto,
    );

    if (allConflict) return allConflict;

    const updated = await this.taskService.update(userId, target.taskId, {
      ...(parsed.title !== undefined ? { title: parsed.title } : {}),
      ...(parsed.startAt !== undefined ? { startAt: parsed.startAt } : {}),
      ...(parsed.endAt !== undefined ? { endAt: parsed.endAt } : {}),
      ...(parsed.notes !== undefined ? { notes: parsed.notes } : {}),
      ...(parsed.isAllDay !== undefined ? { isAllDay: parsed.isAllDay } : {}),
      ...(parsed.timezone !== undefined ? { timezone: parsed.timezone } : {}),
      ...(parsed.requiresCompletion !== undefined
        ? { requiresCompletion: parsed.requiresCompletion }
        : {}),
      ...(parsed.color !== undefined ? { color: parsed.color } : {}),
      ...(hasGroupChange ? { groupId } : {}),
      // Tri-state recurrence: a DTO sets/replaces, null clears, undefined leaves.
      ...(recurrenceUpdate !== undefined
        ? { recurrence: recurrenceUpdate }
        : {}),
    });

    return { content: `Updated all of "${updated.title}".` };
  }

  /**
   * Runs the recurring-edit conflict check for a `this_and_following` / `all`
   * edit and, on overlap, returns a recoverable default-deny `isError` outcome
   * (ADR 0011) restating the series clash — so the model asks the user or (once
   * authorized) retries with `confirmOverlap`. Returns null when the model already
   * set `confirmOverlap`, when the effective series is clear, or when the scope is
   * not series-shaped (the caller then writes normally). Centralizes the check so
   * both scopes route through the identical default-deny gate (Story 9).
   */
  private async recurringEditConflict(
    context: ToolDispatchContext,
    taskId: string,
    parsed: ReturnType<typeof updateTaskInputSchema.parse>,
    recurrenceDto: CreateRecurrenceRuleDto | undefined,
  ): Promise<ToolDispatchOutcome | null> {
    const scope = parsed.editScope;

    // Authorized (in-message confirmOverlap OR a standing ALLOW policy) — skip the
    // gate so the write commits. A standing DENY policy is NOT authorization: it
    // falls through and the clash is refused below with the deny restatement.
    if (this.isOverlapAuthorized(parsed.confirmOverlap, context)) return null;

    // Only the two series-shaped scopes are checked; `this` is a single-occurrence
    // override handled by its own branch and never reaches here.
    if (scope !== 'all' && scope !== 'this_and_following') return null;

    // Explicitly clearing the end makes the series open-ended — a windowless
    // series cannot overlap, so there is nothing to refuse. (TaskService also
    // short-circuits this, but bailing here avoids the needless anchor read.)
    if (parsed.endAt === null) return null;

    const seriesConflicts = await this.taskService.findRecurringEditConflicts(
      context.userId,
      taskId,
      {
        ...(parsed.startAt !== undefined && parsed.startAt !== null
          ? { startAt: parsed.startAt }
          : {}),
        ...(parsed.endAt !== undefined && parsed.endAt !== null
          ? { endAt: parsed.endAt }
          : {}),
        ...(parsed.title !== undefined ? { title: parsed.title } : {}),
        ...(recurrenceDto ? { recurrence: recurrenceDto } : {}),
      },
    );

    if (seriesConflicts.conflictDates.length === 0) return null;

    return this.isOverlapDenied(context)
      ? buildDenyPolicyResult(seriesConflicts.conflictingTasks)
      : buildSeriesConflictResult(seriesConflicts);
  }

  /**
   * Runs the default-deny conflict gate (ADR 0011 + 0044) for a `this`-scope
   * occurrence MOVE — the single-occurrence counterpart of {@link updateOneOff}'s
   * gate — and on overlap returns a recoverable `isError` outcome (the deny
   * restatement under a standing DENY policy, the plain conflict otherwise). It
   * refuses dropping one occurrence onto an existing commitment without
   * authorization, so a `this`-scope override can no longer silently double-book.
   *
   * Returns null (the caller then overrides as before) when the override does NOT
   * change the occurrence's time (a pure rename / completion / notes-only edit
   * needs no check), when the write is authorized (in-message `confirmOverlap` OR a
   * standing ALLOW policy) — UNLESS a DENY policy forces the check — or when the
   * effective occurrence window is not a concrete timed `[start, end)` (an
   * end-less/all-day occurrence cannot overlap, mirroring `findOverlapping`). The
   * series' own anchor is excluded from the scan so the occurrence never clashes
   * with its own series (exactly as `updateOneOff` excludes the edited task).
   */
  private async occurrenceMoveConflict(
    context: ToolDispatchContext,
    task: Task,
    originalStart: Date,
    parsed: ReturnType<typeof updateTaskInputSchema.parse>,
    existingException: TaskOccurrenceException | null,
  ): Promise<ToolDispatchOutcome | null> {
    // A non-time override (rename / completion / notes) never needs a conflict
    // check — only a real MOVE (a new start and/or end) can land on a commitment.
    // A `startAt: null` (clear) does NOT move an occurrence: a single recurring
    // instance cannot be made timeless (its originalStart is its identity), so it
    // is treated as "no start move" everywhere on the `this` path.
    const movesStart = parsed.startAt !== undefined && parsed.startAt !== null;
    const movesTime = movesStart || parsed.endAt !== undefined;

    if (!movesTime) return null;

    // Authorized (in-message confirmOverlap OR a standing ALLOW policy) — skip the
    // gate so the move commits. A standing DENY is NOT authorization: it falls
    // through and the clash is refused below with the deny restatement.
    if (this.isOverlapAuthorized(parsed.confirmOverlap, context)) return null;

    // The occurrence's CURRENT effective window — what a read shows — already
    // reflects any prior override (a moved start, a changed length). Resolve the
    // post-move window from THAT, not the master: the new start is the override
    // start when set, else the current effective start; when only the start
    // moved, the occurrence keeps its current TRUE span as it slides.
    const current = this.effectiveOccurrenceWindow(
      task,
      originalStart,
      existingException,
    );
    const nextStart = movesStart
      ? new Date(parsed.startAt as string)
      : current.start;
    const nextEnd = this.resolveOccurrenceMoveEnd(current, nextStart, parsed);

    // No concrete timed window (end-less / all-day occurrence) ⇒ nothing can
    // overlap, mirroring `findOverlapping`'s [start, end) contract — proceed.
    if (!nextStart || !nextEnd) return null;

    const conflicts = await this.taskService.findOverlapping(
      context.userId,
      task.calendarId,
      nextStart,
      nextEnd,
      // Exclude the series' own anchor so the occurrence is not counted as
      // clashing with its own series (the same self-exclusion `updateOneOff` uses).
      task.id,
    );

    if (conflicts.length === 0) return null;

    return this.isOverlapDenied(context)
      ? buildDenyPolicyResult(conflicts)
      : buildConflictResult(conflicts);
  }

  /**
   * Resolves an occurrence's effective CURRENT window `[start, end)` — what a
   * read would show — from the master anchor plus any existing override row,
   * mirroring `RecurrenceRuleService.buildOccurrence`: the start is the override
   * start when set (else the original slot); the end is the override end when set
   * (else the master duration applied to that start). `end` is null only when the
   * series is end-less (no duration to carry) AND no end override exists — an
   * uncheckable, un-slideable window.
   */
  private effectiveOccurrenceWindow(
    task: Task,
    originalStart: Date,
    existingException: TaskOccurrenceException | null,
  ): { start: Date; end: Date | null } {
    const start = existingException?.overrideStartAt ?? originalStart;
    const masterDurationMs =
      task.startAt && task.endAt
        ? task.endAt.getTime() - task.startAt.getTime()
        : null;
    const end =
      existingException?.overrideEndAt ??
      (masterDurationMs !== null
        ? new Date(start.getTime() + masterDurationMs)
        : null);

    return { start, end };
  }

  /**
   * Resolves the effective END of a `this`-scope occurrence move: the override end
   * when the model set `endAt` (a non-null new end), null when it explicitly
   * cleared the end (end-less ⇒ uncheckable), otherwise — when only the start
   * moved — the occurrence's CURRENT effective duration (`current.end −
   * current.start`, which already reflects any prior length override) re-applied
   * to the NEW start, so the window keeps its TRUE length as it slides. Returns
   * null when the occurrence has no current end (end-less series ⇒ nothing to
   * carry), which the caller treats as "no window to check".
   */
  private resolveOccurrenceMoveEnd(
    current: { start: Date; end: Date | null },
    nextStart: Date,
    parsed: ReturnType<typeof updateTaskInputSchema.parse>,
  ): Date | null {
    if (parsed.endAt !== undefined) {
      return parsed.endAt ? new Date(parsed.endAt) : null;
    }

    if (!current.end) return null;

    const durationMs = current.end.getTime() - current.start.getTime();

    return new Date(nextStart.getTime() + durationMs);
  }

  /**
   * Builds the occurrence-override changes for a `this`-scope edit. Title and an
   * explicit `endAt` (set or cleared) pass straight through. The fix the common
   * path does NOT need: a start-ONLY move on an occurrence that already carries an
   * end override ALSO rewrites `overrideEndAt` to `newStart + currentSpan`, so the
   * persisted window keeps its true length instead of stranding the prior end
   * paired with the new start (which silently resizes — or inverts, when the new
   * start passes the old end — the occurrence). With no prior end override the
   * end is omitted exactly as before: a read derives it from the master duration
   * off the new start.
   */
  private buildOccurrenceOverrideChanges(
    task: Task,
    originalStart: Date,
    parsed: ReturnType<typeof updateTaskInputSchema.parse>,
    existingException: TaskOccurrenceException | null,
  ): OccurrenceOverrideChanges {
    // A `startAt: null` (clear) is ignored on the `this` path: a single recurring
    // occurrence cannot be made timeless (its originalStart is its identity), so
    // only a non-null new start is persisted as an `overrideStartAt` move.
    const movesStart = parsed.startAt !== undefined && parsed.startAt !== null;

    const changes: OccurrenceOverrideChanges = {
      ...(parsed.title !== undefined ? { overrideTitle: parsed.title } : {}),
      ...(movesStart
        ? { overrideStartAt: new Date(parsed.startAt as string) }
        : {}),
      ...(parsed.endAt !== undefined
        ? { overrideEndAt: parsed.endAt ? new Date(parsed.endAt) : null }
        : {}),
    };

    const isStartOnlyMove = movesStart && parsed.endAt === undefined;

    if (isStartOnlyMove && existingException?.overrideEndAt) {
      const current = this.effectiveOccurrenceWindow(
        task,
        originalStart,
        existingException,
      );

      if (current.end) {
        const durationMs = current.end.getTime() - current.start.getTime();

        changes.overrideEndAt = new Date(
          new Date(parsed.startAt as string).getTime() + durationMs,
        );
      }
    }

    return changes;
  }

  /**
   * Updates a one-off task (the `all` / single-row path): resolves an optional
   * group rename, then runs the default-deny conflict gate (ADR 0011) on a timed
   * move — REFUSING an overlap with a recoverable restatement unless the model set
   * `confirmOverlap` (the user authorized it) — before writing.
   */
  private async updateOneOff(
    context: ToolDispatchContext,
    task: Task,
    parsed: ReturnType<typeof updateTaskInputSchema.parse>,
    recurrenceUpdate: CreateRecurrenceRuleDto | null | undefined,
  ): Promise<ToolDispatchOutcome> {
    const groupResolution = await this.resolveGroupUpdate(
      context.userId,
      parsed.group,
    );

    if (groupResolution.outcome) return groupResolution.outcome;

    const hasGroupChange = parsed.group !== undefined;
    const groupId = groupResolution.groupId;

    // startAt / endAt are both tri-state: a string sets, an explicit null clears
    // (startAt:null reverts a timed task to a timeless todo), undefined keeps the
    // current value.
    const nextStartAt =
      parsed.startAt !== undefined
        ? parsed.startAt
          ? new Date(parsed.startAt)
          : null
        : task.startAt;
    const nextEndAt =
      parsed.endAt !== undefined
        ? parsed.endAt
          ? new Date(parsed.endAt)
          : null
        : task.endAt;

    // Default-deny conflict gate (ADR 0011 + 0044): a timed move that overlaps an
    // existing commitment is REFUSED with a recoverable restatement unless it is
    // authorized (the model set `confirmOverlap` OR a standing ALLOW policy). A
    // standing DENY policy forces the check even with `confirmOverlap` and refuses
    // with the deny restatement.
    if (
      !this.isOverlapAuthorized(parsed.confirmOverlap, context) &&
      nextStartAt &&
      nextEndAt
    ) {
      const conflicts = await this.taskService.findOverlapping(
        context.userId,
        task.calendarId,
        nextStartAt,
        nextEndAt,
        task.id,
      );

      if (conflicts.length > 0) {
        return this.isOverlapDenied(context)
          ? buildDenyPolicyResult(conflicts)
          : buildConflictResult(conflicts);
      }
    }

    const updated = await this.taskService.update(context.userId, task.id, {
      ...(parsed.title !== undefined ? { title: parsed.title } : {}),
      ...(parsed.startAt !== undefined ? { startAt: parsed.startAt } : {}),
      ...(parsed.endAt !== undefined ? { endAt: parsed.endAt } : {}),
      ...(parsed.notes !== undefined ? { notes: parsed.notes } : {}),
      ...(parsed.isAllDay !== undefined ? { isAllDay: parsed.isAllDay } : {}),
      ...(parsed.timezone !== undefined ? { timezone: parsed.timezone } : {}),
      ...(parsed.requiresCompletion !== undefined
        ? { requiresCompletion: parsed.requiresCompletion }
        : {}),
      ...(parsed.color !== undefined ? { color: parsed.color } : {}),
      ...(hasGroupChange ? { groupId } : {}),
      // Tri-state recurrence: a DTO sets/replaces, null clears, undefined leaves.
      ...(recurrenceUpdate !== undefined
        ? { recurrence: recurrenceUpdate }
        : {}),
    });

    return { content: `Updated "${updated.title}".` };
  }

  /**
   * Handles `complete_task`: resolves the handle and toggles completion. A
   * recurring instance (non-null `originalStart` on a recurring task) toggles
   * per-occurrence; everything else toggles the master / one-off row.
   */
  async handleCompleteTask(
    input: Record<string, unknown>,
    context: ToolDispatchContext,
  ): Promise<ToolDispatchOutcome> {
    const parsed = completeTaskInputSchema.parse(input);
    const target = this.handleMapOf(context).resolve(parsed.handle);

    if (!target) return STALE_HANDLE_RESULT;

    const completed = parsed.completed ?? true;
    const task = await this.taskService.findById(context.userId, target.taskId);

    if (task.recurrenceConfig !== null && target.originalStart !== null) {
      await this.taskService.setOccurrenceCompleted(
        context.userId,
        target.taskId,
        target.originalStart,
        completed,
      );
    } else {
      await this.taskService.setCompleted(target.taskId, completed);
    }

    return {
      content: completed ? 'Marked complete.' : 'Marked incomplete.',
    };
  }

  /**
   * Handles `delete_task`: resolves the handle and deletes. Skipping a single
   * recurring occurrence uses `editScope:"this"` (an `isSkipped` override);
   * `this_and_following` TRUNCATES the series at the occurrence (ends the rule
   * the day before, preserving past occurrences) rather than destroying the
   * whole series; a recurring task without a scope asks the model to choose; a
   * one-off (or `all`) is soft-deleted.
   *
   * Every path here DESTROYS an existing commitment, so it is gated behind an
   * explicit `confirmDelete` (Story 15 / ADR 0011 + 0044, destructive replace): the
   * scope question still fires first when the scope is ambiguous (the model must
   * know what it is deleting before it can confirm), but once the scope is settled
   * an absent `confirmDelete` REFUSES with a recoverable "ask the user first"
   * instead of deleting. `confirmOverlap` and a standing allow-policy NEVER satisfy
   * this — a destructive replace always asks, even with an allow policy.
   */
  async handleDeleteTask(
    input: Record<string, unknown>,
    context: ToolDispatchContext,
  ): Promise<ToolDispatchOutcome> {
    const parsed = deleteTaskInputSchema.parse(input);
    const target = this.handleMapOf(context).resolve(parsed.handle);

    if (!target) return STALE_HANDLE_RESULT;

    const task = await this.taskService.findById(context.userId, target.taskId);
    const isRecurringInstance =
      task.recurrenceConfig !== null && target.originalStart !== null;

    // Ask which scope FIRST when a repeating task is targeted without one — the
    // model cannot meaningfully confirm a delete whose extent it has not pinned.
    if (isRecurringInstance && !parsed.editScope) {
      return ASK_EDIT_SCOPE_RESULT;
    }

    // Destructive-replace gate: with the scope settled, a delete is irreversible,
    // so it ALWAYS asks first unless the user explicitly confirmed THIS delete
    // (confirmDelete). No write happens otherwise.
    if (!parsed.confirmDelete) {
      return ASK_BEFORE_DELETE_RESULT;
    }

    if (isRecurringInstance && parsed.editScope === 'this') {
      await this.taskService.applyOccurrenceOverride(
        context.userId,
        target.taskId,
        target.originalStart as Date,
        { isSkipped: true },
      );

      return { content: 'Removed this occurrence.' };
    }

    if (isRecurringInstance && parsed.editScope === 'this_and_following') {
      await this.taskService.endSeriesAt(
        context.userId,
        target.taskId,
        target.originalStart as Date,
      );

      return { content: 'Removed this and the following occurrences.' };
    }

    await this.taskService.remove(context.userId, target.taskId);

    return { content: 'Task deleted.' };
  }

  /**
   * Handles `list_groups`: lists the user's task groups by name. Groups are
   * referenced by name elsewhere, so this is the model's view of what exists.
   */
  async handleListGroups(
    input: Record<string, unknown>,
    context: ToolDispatchContext,
  ): Promise<ToolDispatchOutcome> {
    listGroupsInputSchema.parse(input);

    const groups = await this.taskGroupService.findAllForUser(context.userId);

    if (groups.length === 0) {
      return { content: 'No groups yet.' };
    }

    const overflow = groups.length - MAX_LIST_LINES;
    const shown = overflow > 0 ? groups.slice(0, MAX_LIST_LINES) : groups;
    const names = shown.map((group) => group.name).join(', ');

    return {
      content: overflow > 0 ? `${names} (+${overflow} more)` : names,
    };
  }

  /**
   * Handles `create_group`: resolves the calendar and creates a task group,
   * threading the optional inherited defaults (color, recurrence, completion
   * requirement) through to the service.
   */
  async handleCreateGroup(
    input: Record<string, unknown>,
    context: ToolDispatchContext,
  ): Promise<ToolDispatchOutcome> {
    const parsed = createGroupInputSchema.parse(input);
    const calendarId = await this.resolveCalendarId(context.userId);

    if (!calendarId) {
      return {
        content: 'Error: no calendar is available to create the group in.',
        isError: true,
      };
    }

    const group = await this.taskGroupService.create(context.userId, {
      calendarId,
      name: parsed.name,
      color: parsed.color,
      icon: parsed.icon,
      requiresCompletion: parsed.requiresCompletion,
      recurrence: parsed.recurrence
        ? this.toRecurrenceDto(parsed.recurrence)
        : undefined,
    });

    return { content: `Created group "${group.name}".` };
  }

  /**
   * Handles `update_group`: resolves the group BY NAME (the same `resolveGroup`
   * the create/update-task paths use — zero / multiple matches surface as a
   * recoverable result), then renames it and/or changes its inherited defaults
   * (color, icon, recurrence, completion requirement). Each settable field is a
   * tri-state — a value SETS it, `null` CLEARS the group default, an omitted key
   * leaves it — mirroring how `update_task` clears recurrence with null. A write;
   * not a schedule-fetch.
   */
  async handleUpdateGroup(
    input: Record<string, unknown>,
    context: ToolDispatchContext,
  ): Promise<ToolDispatchOutcome> {
    const parsed = updateGroupInputSchema.parse(input);
    const resolution = await this.resolveGroup(context.userId, parsed.group);

    if (resolution.outcome) return resolution.outcome;

    const recurrenceUpdate = this.resolveRecurrenceUpdate(parsed.recurrence);

    const group = await this.taskGroupService.update(
      context.userId,
      resolution.groupId as string,
      {
        ...(parsed.name !== undefined ? { name: parsed.name } : {}),
        ...(parsed.sortOrder !== undefined
          ? { sortOrder: parsed.sortOrder }
          : {}),
        ...(parsed.color !== undefined ? { color: parsed.color } : {}),
        ...(parsed.icon !== undefined ? { icon: parsed.icon } : {}),
        ...(parsed.requiresCompletion !== undefined
          ? { requiresCompletion: parsed.requiresCompletion }
          : {}),
        ...(recurrenceUpdate !== undefined
          ? { recurrence: recurrenceUpdate }
          : {}),
      },
    );

    return { content: `Updated group "${group.name}".` };
  }

  /**
   * Handles `set_reminder`. Reminder delivery (NotificationStrategy +
   * ScheduledNotification) is owned by the separate notification-delivery spec
   * and not wired yet, so this resolves the handle for parity and returns a
   * graceful tool result the assistant can relay rather than silently failing or
   * promising a reminder it can't set.
   */
  handleSetReminder(
    input: Record<string, unknown>,
    context: ToolDispatchContext,
  ): ToolDispatchOutcome {
    const parsed = setReminderInputSchema.parse(input);
    const target = this.handleMapOf(context).resolve(parsed.handle);

    if (!target) return STALE_HANDLE_RESULT;

    return {
      content:
        'Reminders are not available yet; tell the user this capability is coming soon.',
    };
  }

  /**
   * Handles `ask_user` (ADR 0010). Touches NO database and calls no feature
   * service: it parses the validated question + optional options and returns the
   * `askUser` SENTINEL. The orchestrator recognizes it, stops the loop, and
   * suspends the turn (persists the durable `pending_question` row, mirrors to
   * Redis, sends the question), resuming on the user's answer. `content` is a
   * benign placeholder that is never fed back to the model — the suspended round
   * deliberately omits this call's `tool_result` (the ADR-0010 wire invariant),
   * which is synthesized from the user's answer on resume.
   */
  handleAskUser(
    input: Record<string, unknown>,
    _context: ToolDispatchContext,
  ): ToolDispatchOutcome {
    const parsed = askUserInputSchema.parse(input);

    return {
      content: 'Asked the user; the turn is suspended pending their answer.',
      askUser: {
        question: parsed.question,
        options: (parsed.options ?? []).map((option) => ({
          id: option.id,
          label: option.label,
        })),
      },
    };
  }

  /**
   * Dispatches one tool call through the {@link ToolRegistry}, which validates
   * the input (recoverable `isError` result on an unknown tool or a validation
   * failure) and runs the matched tool against this dispatcher as the handler
   * host. The try/catch still flattens any error thrown by a tool body into a
   * short, recoverable `Error: …` outcome (never a raw stack), keeping the model
   * able to recover or clarify — unchanged from the previous switch.
   */
  async dispatch(
    toolCall: ToolCall,
    context: ToolDispatchContext,
  ): Promise<ToolDispatchOutcome> {
    try {
      return await this.registry.run(toolCall, context, this);
    } catch (error) {
      return this.toErrorOutcome(error, context.correlationId);
    }
  }
}
