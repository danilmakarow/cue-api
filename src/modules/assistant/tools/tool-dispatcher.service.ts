import { Injectable, Logger } from '@nestjs/common';
import { DateTime } from 'luxon';
import { ZodError } from 'zod';

import {
  HeldConflictWrite,
  ToolDispatchContext,
  ToolDispatchOutcome,
} from '../assistant.types';
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
  updateTaskInputSchema,
} from './tool-schemas';
import { ToolHandlerHost } from './tool.contract';
import { ToolCall } from '@/modules/ai/ai.types';
import { CalendarService } from '@/modules/calendar/calendar.service';
import { Task } from '@/modules/database/entities';
import { CreateRecurrenceRuleDto } from '@/modules/recurrence-rule/dtos';
import {
  RecurringSeriesConflicts,
  TaskService,
} from '@/modules/task/task.service';
import { TaskGroupService } from '@/modules/task-group/task-group.service';

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
 * Result of resolving a group name: a concrete id, or a recoverable
 * `ToolDispatchOutcome` the model relays (ambiguous / missing). The dispatcher
 * branches on which field is present.
 */
interface GroupResolution {
  groupId?: string;
  outcome?: ToolDispatchOutcome;
}

/** A validated, parsed single-create input (shared by `create_task[s]`). */
type CreateTaskInput = ReturnType<typeof createTaskInputSchema.parse>;

/** Held conflict produced by a single create, ready for the batch-hold path. */
interface CreateHeld {
  promptText: string;
  write: HeldConflictWrite;
}

/**
 * Outcome of attempting one create (shared between `create_task` and the
 * `create_tasks` fan-out). Exactly one field is set: `created` (committed, with
 * its title), `held` (a non-recurring timed overlap parked for confirmation), or
 * `error` (a recoverable resolution failure — missing calendar / group). The
 * dispatcher branches on which is present.
 */
interface CreateAttempt {
  created?: { title: string };
  held?: CreateHeld;
  error?: ToolDispatchOutcome;
}

/**
 * Translates a model {@link ToolCall} into a call on an existing feature service
 * (TaskService / TaskGroupService / CalendarService) and returns a normalized
 * {@link ToolDispatchOutcome}. It never touches repositories or entities
 * directly, never re-invokes the model, and for a conflicting one-off write
 * returns a `heldConflict` rather than executing — the orchestrator owns the
 * hold + the inline-keyboard ask (ADR 0006 layer 4). Mutations address tasks by
 * a per-turn handle the {@link HandleMap} resolves to a `(taskId, originalStart)`
 * coordinate; raw task ids never cross the model boundary.
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
   * timed event, all-day event, or todo (optionally recurring). A non-recurring
   * timed task that overlaps an existing one is held for the user to confirm
   * (never executed on conflict). Recurring creates skip the overlap hold in v1.
   * Delegates the per-item resolution + conflict logic to {@link attemptCreate},
   * the same helper `create_tasks` fans out over, so the two never diverge.
   */
  async handleCreateTask(
    input: Record<string, unknown>,
    context: ToolDispatchContext,
  ): Promise<ToolDispatchOutcome> {
    const parsed = createTaskInputSchema.parse(input);
    const attempt = await this.attemptCreate(parsed, context);

    if (attempt.error) return attempt.error;

    if (attempt.held) {
      return {
        content:
          'The task overlaps an existing one and is held for the user to confirm.',
        heldConflict: attempt.held,
      };
    }

    return { content: `Created "${attempt.created?.title}".` };
  }

  /**
   * Handles `create_tasks`: fans out over the validated batch IN INPUT ORDER,
   * running the SAME per-item resolution + conflict logic as a single
   * `create_task` ({@link attemptCreate}). Non-conflicting items are created
   * immediately; a non-recurring timed item that overlaps an existing one is
   * collected as a held write (the rest still commit — a single overlap never
   * aborts the batch). Returns ONE outcome: a per-item summary as `content`,
   * every held item under `heldConflicts` for the existing batch-hold path, and
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
    const heldConflicts: CreateHeld[] = [];
    let committedCount = 0;

    for (const [index, task] of parsed.tasks.entries()) {
      const position = index + 1;
      const attempt = await this.attemptCreate(task, context);

      if (attempt.error) {
        summaries.push(`${position}: failed (${attempt.error.content})`);
        continue;
      }

      if (attempt.held) {
        heldConflicts.push(attempt.held);
        summaries.push(`${position}: held (${attempt.held.promptText})`);
        continue;
      }

      committedCount += 1;
      summaries.push(`${position}: created "${attempt.created?.title}"`);
    }

    return {
      content: summaries.join('; '),
      // Every item is a write attempt (committed, held, or errored) so the guard
      // and the saved-changes count stay accurate; only non-held, non-errored
      // items count as committed.
      attemptedCount: parsed.tasks.length,
      committedCount,
      ...(heldConflicts.length > 0 ? { heldConflicts } : {}),
    };
  }

  /**
   * Resolves the calendar / group / timezone for one create and either commits
   * it or parks it as a held conflict — the single source of create logic shared
   * by `create_task` and the `create_tasks` fan-out. A non-recurring timed task
   * with a concrete window is conflict-checked and held on overlap (ADR 0006
   * layer 4). A RECURRING timed create is conflict-checked across its whole
   * proposed series (Story 9): the rule is expanded over a bounded horizon and
   * the WHOLE series is held as ONE write if any occurrence overlaps an existing
   * event — so a repeating task routes through the same hold a one-off does
   * instead of committing silently. Non-conflicting recurring creates commit as
   * before. Returns a {@link CreateAttempt} with exactly one of `error` / `held`
   * / `created`.
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

    // A recurring, timed create is conflict-checked across the whole proposed
    // series (Story 9): expand it bounded and hold on ANY occurrence overlap, so
    // a repeating task can never silently book over existing events.
    if (parsed.recurrence && startAt && endAt) {
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
        return {
          held: this.buildCreateRecurringHeld(
            parsed,
            calendarId,
            timezone,
            groupId ?? null,
            seriesConflicts,
            context,
          ),
        };
      }
    }

    if (!parsed.recurrence && startAt && endAt) {
      const conflicts = await this.taskService.findOverlapping(
        context.userId,
        calendarId,
        startAt,
        endAt,
      );

      if (conflicts.length > 0) {
        return {
          held: this.buildCreateHeld(
            parsed,
            calendarId,
            timezone,
            conflicts,
            context,
          ),
        };
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
      groupId,
      recurrence: parsed.recurrence
        ? this.toRecurrenceDto(parsed.recurrence)
        : undefined,
    });

    return { created: { title: created.title } };
  }

  /**
   * Builds the held-conflict record for a conflicting create, carrying the
   * fully-resolved write so the orchestrator can execute it verbatim on confirm.
   * The held-action `kind` and shape are unchanged from the event surface so the
   * orchestrator's existing executor keeps working, and the same record is used
   * by the single-create `heldConflict` and the batch `heldConflicts` paths.
   */
  private buildCreateHeld(
    parsed: CreateTaskInput,
    calendarId: string,
    timezone: string,
    conflicts: Task[],
    context: ToolDispatchContext,
  ): CreateHeld {
    const conflictTitles = conflicts.map((task) => task.title).join(', ');

    return {
      promptText: `That overlaps with ${conflictTitles}. Shall I book it anyway?`,
      write: {
        userId: context.userId,
        vendorChatId: '',
        action: {
          kind: 'create_event',
          calendarId,
          title: parsed.title,
          startAt: parsed.startAt as string,
          endAt: parsed.endAt ?? null,
          timezone,
          notes: parsed.notes ?? null,
        },
      },
    };
  }

  /**
   * Builds the held-conflict record for a conflicting recurring CREATE (Story 9):
   * the WHOLE proposed series is one held write whose `create_recurring_event`
   * action carries the rule grammar + every resolved field, so the orchestrator
   * recreates it verbatim on confirm (bypassing the check — the user chose "book
   * the series anyway"). The prompt counts the distinct clashing dates so the user
   * understands the scope.
   */
  private buildCreateRecurringHeld(
    parsed: CreateTaskInput,
    calendarId: string,
    timezone: string,
    groupId: string | null,
    seriesConflicts: RecurringSeriesConflicts,
    context: ToolDispatchContext,
  ): CreateHeld {
    return {
      promptText: this.formatSeriesConflictPrompt(seriesConflicts),
      write: {
        userId: context.userId,
        vendorChatId: '',
        action: {
          kind: 'create_recurring_event',
          calendarId,
          title: parsed.title,
          startAt: parsed.startAt as string,
          endAt: parsed.endAt as string,
          timezone,
          notes: parsed.notes ?? null,
          groupId,
          isAllDay: parsed.isAllDay ?? false,
          requiresCompletion: parsed.requiresCompletion ?? true,
          recurrence: this.toRecurrenceDto(
            parsed.recurrence as RecurrenceInput,
          ),
        },
      },
    };
  }

  /**
   * Builds the held-conflict prompt for a recurring series whose occurrences
   * overlap existing events — shared by the recurring create and recurring edit
   * holds. Reports the distinct clashing-date count and a few of the overlapping
   * titles so the user can confirm or cancel the whole series.
   */
  private formatSeriesConflictPrompt(
    seriesConflicts: RecurringSeriesConflicts,
  ): string {
    const dateCount = seriesConflicts.conflictDates.length;
    const titles = seriesConflicts.conflictingTasks
      .map((task) => task.title)
      .join(', ');
    const dateLabel = dateCount === 1 ? '1 date' : `${dateCount} dates`;

    return `This repeating task overlaps existing events on ${dateLabel}${
      titles ? ` (${titles})` : ''
    }. Book the series anyway?`;
  }

  /**
   * Handles `update_task`: resolves the handle, then dispatches by recurrence and
   * edit scope. A recurring target requires `editScope` (asks otherwise);
   * `this` → occurrence override, `this_and_following` → series split, `all` →
   * master update. A one-off ignores `editScope` and keeps the conflict hold for
   * a timed move. A `this_and_following` / `all` recurring edit that changes the
   * time or rule is series-conflict-checked and held on overlap (Story 9).
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
      task.recurrenceRuleId !== null && target.originalStart !== null;
    const recurrenceDto = parsed.recurrence
      ? this.toRecurrenceDto(parsed.recurrence)
      : undefined;

    if (isRecurringInstance) {
      return this.updateRecurring(context, target, parsed, recurrenceDto);
    }

    return this.updateOneOff(context, task, parsed, recurrenceDto);
  }

  /**
   * Applies a recurring update at the chosen scope. Absent scope asks the model
   * to choose. `this` overrides the single occurrence; `this_and_following`
   * splits the series; `all` updates the master (resolving an optional group
   * rename by name).
   *
   * A `this_and_following` or `all` edit that changes the time or rule is
   * conflict-checked across the effective post-edit series (Story 9): on any
   * occurrence overlap it routes through the SAME ADR-0006 hold a one-off move
   * does — held as ONE `update_recurring_event` write that replays the chosen
   * scope verbatim on confirm — instead of silently booking over existing events.
   * The `this` scope retargets a single occurrence and keeps its prior behaviour
   * (it is a one-instance override, not a series write).
   */
  private async updateRecurring(
    context: ToolDispatchContext,
    target: HandleTarget,
    parsed: ReturnType<typeof updateTaskInputSchema.parse>,
    recurrenceDto: CreateRecurrenceRuleDto | undefined,
  ): Promise<ToolDispatchOutcome> {
    const scope = parsed.editScope;

    if (!scope) return ASK_EDIT_SCOPE_RESULT;

    const userId = context.userId;
    const originalStart = target.originalStart as Date;

    if (scope === 'this') {
      await this.taskService.applyOccurrenceOverride(
        userId,
        target.taskId,
        originalStart,
        {
          ...(parsed.title !== undefined
            ? { overrideTitle: parsed.title }
            : {}),
          ...(parsed.startAt !== undefined
            ? { overrideStartAt: new Date(parsed.startAt) }
            : {}),
          ...(parsed.endAt !== undefined
            ? { overrideEndAt: parsed.endAt ? new Date(parsed.endAt) : null }
            : {}),
        },
      );

      return { content: 'Updated this occurrence.' };
    }

    if (scope === 'this_and_following') {
      // Resolve the group BEFORE splitting: a name that is ambiguous or missing
      // must surface as a recoverable result without having mutated the series,
      // otherwise we would split and then report a partial / false success.
      let splitGroupId: string | undefined;

      if (parsed.group) {
        const resolution = await this.resolveGroup(userId, parsed.group);

        if (resolution.outcome) return resolution.outcome;

        splitGroupId = resolution.groupId;
      }

      const splitConflictHold = await this.recurringEditHold(
        context,
        target.taskId,
        originalStart,
        parsed,
        recurrenceDto,
        splitGroupId ?? null,
      );

      if (splitConflictHold) return splitConflictHold;

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
          ...(splitGroupId !== undefined ? { groupId: splitGroupId } : {}),
          ...(recurrenceDto ? { recurrence: recurrenceDto } : {}),
        },
      );

      return splitGroupId !== undefined
        ? {
            content: `Updated "${newMaster.title}" and following, and moved them to the group.`,
          }
        : { content: `Updated "${newMaster.title}" and following.` };
    }

    let groupId: string | undefined;

    if (parsed.group) {
      const resolution = await this.resolveGroup(userId, parsed.group);

      if (resolution.outcome) return resolution.outcome;

      groupId = resolution.groupId;
    }

    const allConflictHold = await this.recurringEditHold(
      context,
      target.taskId,
      originalStart,
      parsed,
      recurrenceDto,
      groupId ?? null,
    );

    if (allConflictHold) return allConflictHold;

    const updated = await this.taskService.update(userId, target.taskId, {
      ...(parsed.title !== undefined ? { title: parsed.title } : {}),
      ...(parsed.startAt !== undefined ? { startAt: parsed.startAt } : {}),
      ...(parsed.endAt !== undefined ? { endAt: parsed.endAt } : {}),
      ...(groupId !== undefined ? { groupId } : {}),
      ...(recurrenceDto ? { recurrence: recurrenceDto } : {}),
    });

    return { content: `Updated all of "${updated.title}".` };
  }

  /**
   * Runs the recurring-edit conflict check for a `this_and_following` / `all`
   * edit and, on overlap, returns the held `update_recurring_event` outcome that
   * replays the chosen scope verbatim on confirm; returns null when the effective
   * series is clear (the caller then writes normally). Centralizes the check so
   * both scopes route through the identical ADR-0006 hold (Story 9). `groupId` is
   * the already-resolved group (or null) so the confirm-time replay needs no
   * re-resolution.
   */
  private async recurringEditHold(
    context: ToolDispatchContext,
    taskId: string,
    originalStart: Date,
    parsed: ReturnType<typeof updateTaskInputSchema.parse>,
    recurrenceDto: CreateRecurrenceRuleDto | undefined,
    groupId: string | null,
  ): Promise<ToolDispatchOutcome | null> {
    const scope = parsed.editScope;

    // Only the two series-shaped scopes are held; `this` is a single-occurrence
    // override handled by its own branch and never reaches here.
    if (scope !== 'all' && scope !== 'this_and_following') return null;

    // Explicitly clearing the end makes the series open-ended — a windowless
    // series cannot overlap, so there is nothing to hold. (TaskService also
    // short-circuits this, but bailing here avoids the needless anchor read.)
    if (parsed.endAt === null) return null;

    const seriesConflicts = await this.taskService.findRecurringEditConflicts(
      context.userId,
      taskId,
      {
        ...(parsed.startAt !== undefined ? { startAt: parsed.startAt } : {}),
        ...(parsed.endAt !== undefined && parsed.endAt !== null
          ? { endAt: parsed.endAt }
          : {}),
        ...(parsed.title !== undefined ? { title: parsed.title } : {}),
        ...(recurrenceDto ? { recurrence: recurrenceDto } : {}),
      },
    );

    if (seriesConflicts.conflictDates.length === 0) return null;

    return {
      content:
        'The recurring edit overlaps existing events and is held for the user to confirm.',
      heldConflict: {
        promptText: this.formatSeriesConflictPrompt(seriesConflicts),
        write: {
          userId: context.userId,
          vendorChatId: '',
          action: {
            kind: 'update_recurring_event',
            taskId,
            editScope: scope,
            originalStart: originalStart.toISOString(),
            title: parsed.title ?? null,
            startAt: parsed.startAt ?? null,
            endAt: parsed.endAt ?? null,
            groupId,
            recurrence: recurrenceDto
              ? this.toRecurrenceDto(parsed.recurrence as RecurrenceInput)
              : null,
          },
        },
      },
    };
  }

  /**
   * Updates a one-off task (the `all` / single-row path): resolves an optional
   * group rename, conflict-checks a timed move (holding on overlap), then writes.
   */
  private async updateOneOff(
    context: ToolDispatchContext,
    task: Task,
    parsed: ReturnType<typeof updateTaskInputSchema.parse>,
    recurrenceDto: CreateRecurrenceRuleDto | undefined,
  ): Promise<ToolDispatchOutcome> {
    let groupId: string | undefined;

    if (parsed.group) {
      const resolution = await this.resolveGroup(context.userId, parsed.group);

      if (resolution.outcome) return resolution.outcome;

      groupId = resolution.groupId;
    }

    const nextStartAt =
      parsed.startAt !== undefined ? new Date(parsed.startAt) : task.startAt;
    const nextEndAt =
      parsed.endAt !== undefined
        ? parsed.endAt
          ? new Date(parsed.endAt)
          : null
        : task.endAt;

    if (nextStartAt && nextEndAt) {
      const conflicts = await this.taskService.findOverlapping(
        context.userId,
        task.calendarId,
        nextStartAt,
        nextEndAt,
        task.id,
      );

      if (conflicts.length > 0) {
        return this.heldUpdateOutcome(
          context.userId,
          task.id,
          nextStartAt,
          nextEndAt,
          conflicts,
        );
      }
    }

    const updated = await this.taskService.update(context.userId, task.id, {
      ...(parsed.title !== undefined ? { title: parsed.title } : {}),
      ...(parsed.startAt !== undefined ? { startAt: parsed.startAt } : {}),
      ...(parsed.endAt !== undefined ? { endAt: parsed.endAt } : {}),
      ...(groupId !== undefined ? { groupId } : {}),
      ...(recurrenceDto ? { recurrence: recurrenceDto } : {}),
    });

    return { content: `Updated "${updated.title}".` };
  }

  /**
   * Builds the `heldConflict` for a conflicting one-off timed move, carrying the
   * resolved update so the orchestrator executes it verbatim on confirm. Shape
   * and `kind` are unchanged from the event surface.
   */
  private heldUpdateOutcome(
    userId: string,
    taskId: string,
    nextStartAt: Date,
    nextEndAt: Date,
    conflicts: Task[],
  ): ToolDispatchOutcome {
    const conflictTitles = conflicts.map((task) => task.title).join(', ');

    return {
      content:
        'The updated time overlaps an existing task and is held for the user to confirm.',
      heldConflict: {
        promptText: `That overlaps with ${conflictTitles}. Shall I move it anyway?`,
        write: {
          userId,
          vendorChatId: '',
          action: {
            kind: 'update_event',
            taskId,
            startAt: nextStartAt.toISOString(),
            endAt: nextEndAt.toISOString(),
          },
        },
      },
    };
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

    if (task.recurrenceRuleId !== null && target.originalStart !== null) {
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
      task.recurrenceRuleId !== null && target.originalStart !== null;

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

    if (isRecurringInstance && !parsed.editScope) {
      return ASK_EDIT_SCOPE_RESULT;
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
   * Handles `create_group`: resolves the calendar and creates a task group.
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
    });

    return { content: `Created group "${group.name}".` };
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
