import { Injectable, Logger } from '@nestjs/common';
import { DateTime } from 'luxon';
import { ZodError } from 'zod';

import { ToolDispatchContext, ToolDispatchOutcome } from '../assistant.types';
import { formatTaskLine } from '../event-formatting';
import { ScheduleReaderService } from '../schedule-reader.service';
import { HandleMap, HandleTarget } from './handle-map';
import {
  RecurrenceInput,
  ToolName,
  completeTaskInputSchema,
  createGroupInputSchema,
  createTaskInputSchema,
  deleteTaskInputSchema,
  findFreeSlotsInputSchema,
  listGroupsInputSchema,
  listTasksInputSchema,
  setReminderInputSchema,
  updateTaskInputSchema,
} from './tool-schemas';
import { ToolCall } from '@/modules/ai/ai.types';
import { CalendarService } from '@/modules/calendar/calendar.service';
import { Task } from '@/modules/database/entities';
import { CreateRecurrenceRuleDto } from '@/modules/recurrence-rule/dtos';
import { TaskService } from '@/modules/task/task.service';
import { TaskGroupService } from '@/modules/task-group/task-group.service';

/** Maximum free slots returned by `find_free_slots` to keep results compact. */
const MAX_FREE_SLOTS = 5;

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
export class ToolDispatcherService {
  private readonly logger = new Logger(ToolDispatcherService.name);

  constructor(
    private readonly taskService: TaskService,
    private readonly taskGroupService: TaskGroupService,
    private readonly calendarService: CalendarService,
    private readonly scheduleReader: ScheduleReaderService,
  ) {}

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
  private async handleListTasks(
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
    const lines = filtered.map((occurrence) =>
      formatTaskLine(
        occurrence,
        context.user.timezone,
        handleMap.addOccurrence(occurrence),
      ),
    );

    return { content: lines.join('\n'), countsAsScheduleFetch: true };
  }

  /**
   * Handles `find_free_slots`: walks the busy occurrences (those with a concrete
   * start+end) in range and returns the gaps of at least `durationMinutes`.
   * Counts against the schedule-fetch cap.
   */
  private async handleFindFreeSlots(
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
   * Handles `create_task`: resolves the calendar / group / timezone and creates a
   * timed event, all-day event, or todo (optionally recurring). A non-recurring
   * timed task that overlaps an existing one is held for the user to confirm
   * (never executed on conflict). Recurring creates skip the overlap hold in v1.
   */
  private async handleCreateTask(
    input: Record<string, unknown>,
    context: ToolDispatchContext,
  ): Promise<ToolDispatchOutcome> {
    const parsed = createTaskInputSchema.parse(input);
    const calendarId = await this.resolveCalendarId(
      context.userId,
      parsed.calendarId,
    );

    if (!calendarId) {
      return {
        content: 'Error: no calendar is available to create the task in.',
        isError: true,
      };
    }

    let groupId: string | undefined;

    if (parsed.group) {
      const resolution = await this.resolveGroup(context.userId, parsed.group);

      if (resolution.outcome) return resolution.outcome;

      groupId = resolution.groupId;
    }

    const timezone = parsed.timezone ?? context.user.timezone;
    const startAt = parsed.startAt ? new Date(parsed.startAt) : null;
    const endAt = parsed.endAt ? new Date(parsed.endAt) : null;

    // Recurring creates intentionally skip the overlap hold in v1 — an expanded
    // series can clash on many dates and the held-action mechanism is one-write,
    // so per-occurrence conflict UX is a deliberate deferral (see
    // docs/specs/assistant-task-tools.md "Recurring edits" + the conflict-hold
    // deferral note), NOT an oversight. Only a non-recurring timed task with a
    // concrete window is conflict-checked and held (ADR 0006 layer 4 — unchanged
    // held-action shape).
    if (!parsed.recurrence && startAt && endAt) {
      const conflicts = await this.taskService.findOverlapping(
        context.userId,
        calendarId,
        startAt,
        endAt,
      );

      if (conflicts.length > 0) {
        return this.heldCreateOutcome(
          parsed,
          calendarId,
          timezone,
          conflicts,
          context,
        );
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

    return { content: `Created "${created.title}".` };
  }

  /**
   * Builds the `heldConflict` outcome for a conflicting create, carrying the
   * fully-resolved write so the orchestrator can execute it verbatim on confirm.
   * The held-action `kind` and shape are unchanged from the event surface so the
   * orchestrator's existing executor keeps working.
   */
  private heldCreateOutcome(
    parsed: ReturnType<typeof createTaskInputSchema.parse>,
    calendarId: string,
    timezone: string,
    conflicts: Task[],
    context: ToolDispatchContext,
  ): ToolDispatchOutcome {
    const conflictTitles = conflicts.map((task) => task.title).join(', ');

    return {
      content:
        'The task overlaps an existing one and is held for the user to confirm.',
      heldConflict: {
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
      },
    };
  }

  /**
   * Handles `update_task`: resolves the handle, then dispatches by recurrence and
   * edit scope. A recurring target requires `editScope` (asks otherwise);
   * `this` → occurrence override, `this_and_following` → series split, `all` →
   * master update. A one-off ignores `editScope` and keeps the conflict hold for
   * a timed move. Recurring-edit conflict UX is deferred (no hold here).
   */
  private async handleUpdateTask(
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
   * rename by name). Recurring-edit conflict UX is deferred — no hold here.
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
  private async handleCompleteTask(
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
  private async handleDeleteTask(
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
  private async handleListGroups(
    input: Record<string, unknown>,
    context: ToolDispatchContext,
  ): Promise<ToolDispatchOutcome> {
    listGroupsInputSchema.parse(input);

    const groups = await this.taskGroupService.findAllForUser(context.userId);

    if (groups.length === 0) {
      return { content: 'No groups yet.' };
    }

    return { content: groups.map((group) => group.name).join(', ') };
  }

  /**
   * Handles `create_group`: resolves the calendar and creates a task group.
   */
  private async handleCreateGroup(
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
  private handleSetReminder(
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
   * Dispatches one tool call to its handler. Unknown tool names and input
   * validation failures return an error outcome (fed back to the model as a
   * tool result) rather than throwing — the model can recover or clarify.
   */
  async dispatch(
    toolCall: ToolCall,
    context: ToolDispatchContext,
  ): Promise<ToolDispatchOutcome> {
    try {
      switch (toolCall.name) {
        case ToolName.LIST_TASKS:
          return await this.handleListTasks(toolCall.input, context);
        case ToolName.FIND_FREE_SLOTS:
          return await this.handleFindFreeSlots(toolCall.input, context);
        case ToolName.CREATE_TASK:
          return await this.handleCreateTask(toolCall.input, context);
        case ToolName.UPDATE_TASK:
          return await this.handleUpdateTask(toolCall.input, context);
        case ToolName.COMPLETE_TASK:
          return await this.handleCompleteTask(toolCall.input, context);
        case ToolName.DELETE_TASK:
          return await this.handleDeleteTask(toolCall.input, context);
        case ToolName.SET_REMINDER:
          return this.handleSetReminder(toolCall.input, context);
        case ToolName.LIST_GROUPS:
          return await this.handleListGroups(toolCall.input, context);
        case ToolName.CREATE_GROUP:
          return await this.handleCreateGroup(toolCall.input, context);
        default:
          return {
            content: `Error: unknown tool "${toolCall.name}".`,
            isError: true,
          };
      }
    } catch (error) {
      return this.toErrorOutcome(error, context.correlationId);
    }
  }
}
