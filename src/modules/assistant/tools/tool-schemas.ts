import { z } from 'zod';

import {
  RecurrenceEndType,
  RecurrenceFrequency,
} from '@/modules/database/entities';

/**
 * Canonical tool names the model may call. Shared by the schema list, the
 * dispatcher, and the tests so they never drift (spec tool list).
 */
export const ToolName = {
  LIST_TASKS: 'list_tasks',
  FIND_FREE_SLOTS: 'find_free_slots',
  CREATE_TASK: 'create_task',
  CREATE_TASKS: 'create_tasks',
  UPDATE_TASK: 'update_task',
  COMPLETE_TASK: 'complete_task',
  DELETE_TASK: 'delete_task',
  SET_REMINDER: 'set_reminder',
  LIST_GROUPS: 'list_groups',
  CREATE_GROUP: 'create_group',
  CHECK_AVAILABILITY: 'check_availability',
  ASK_USER: 'ask_user',
} as const;

/** Union of the tool name literals. */
export type ToolNameValue = (typeof ToolName)[keyof typeof ToolName];

/** The three recurring-edit scopes the model may pass on update / delete. */
export const editScopeSchema = z.enum(['this', 'this_and_following', 'all']);

/**
 * Shared model-facing description of the recurring-edit scope, single-sourced for
 * both the Zod validators' `.describe(...)` and the hand-written JSON schema.
 */
const EDIT_SCOPE_DESCRIPTION =
  'For a repeating task: which instances to affect. Omit to be asked which scope; pass only when the user is unambiguous.';

/**
 * Zod validator for the `recurrence` object — mirrors `CreateRecurrenceRuleDto`
 * (RFC-5545-lite) so the dispatcher can hand it straight to `TaskService`.
 * Validates grammar AND the cross-field end rules: a `COUNT` series needs a
 * positive `count` and an `UNTIL_DATE` series needs an `endDate`. These are NOT
 * re-checked downstream — the dispatcher builds the rule via
 * `RecurrenceRuleService.create(createInstance(...))` with no `ValidationPipe`,
 * so without this refine a `{ endType: 'COUNT' }` with no `count` would persist
 * `count: null` and expand as a never-ending series. The dispatcher turns a
 * failure here into a recoverable tool result the model can correct.
 */
export const recurrenceInputSchema = z
  .object({
    frequency: z
      .nativeEnum(RecurrenceFrequency)
      .describe('How often the task repeats.'),
    interval: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('Repeat every N periods (default 1). E.g. 2 = every other.'),
    byWeekday: z
      .array(z.number().int().min(0).max(6))
      .nonempty()
      .optional()
      .describe('Weekday ordinals 0=Mon … 6=Sun (e.g. [0,1,2,3,4] weekdays).'),
    byMonthDay: z
      .array(z.number().int().min(1).max(31))
      .nonempty()
      .optional()
      .describe('Days of the month (1-31).'),
    byMonth: z
      .array(z.number().int().min(1).max(12))
      .nonempty()
      .optional()
      .describe('Months (1-12).'),
    endType: z
      .nativeEnum(RecurrenceEndType)
      .optional()
      .describe('When the series ends.'),
    endDate: z
      .string()
      .optional()
      .describe('ISO date the series ends on; required for UNTIL_DATE.'),
    count: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('Number of occurrences; required for COUNT.'),
  })
  .superRefine((recurrence, ctx) => {
    if (
      recurrence.endType === RecurrenceEndType.COUNT &&
      (recurrence.count === undefined || recurrence.count === null)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['count'],
        message:
          'count is required and must be a positive integer when endType is COUNT.',
      });
    }

    if (
      recurrence.endType === RecurrenceEndType.UNTIL_DATE &&
      (recurrence.endDate === undefined || recurrence.endDate === null)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endDate'],
        message: 'endDate is required when endType is UNTIL_DATE.',
      });
    }
  });

/** Inferred type of a validated `recurrence` input object. */
export type RecurrenceInput = z.infer<typeof recurrenceInputSchema>;

/** Zod schema validating `list_tasks` input. */
export const listTasksInputSchema = z.object({
  from: z
    .string()
    .optional()
    .describe('ISO 8601 start of the range (inclusive). Defaults to today.'),
  to: z
    .string()
    .optional()
    .describe('ISO 8601 end of the range (exclusive). Defaults to a week out.'),
  group: z.string().optional().describe('Optional group name to filter by.'),
  includeCompleted: z
    .boolean()
    .optional()
    .describe('Include completed tasks (default false).'),
  onlyTodos: z
    .boolean()
    .optional()
    .describe('Return only timeless todos (no start time).'),
});

/** Zod schema validating `find_free_slots` input. */
export const findFreeSlotsInputSchema = z.object({
  from: z.string().describe('ISO 8601 start of the range.'),
  to: z.string().describe('ISO 8601 end of the range.'),
  durationMinutes: z
    .number()
    .int()
    .positive()
    .describe('Required slot length in minutes.'),
  calendarId: z
    .string()
    .optional()
    .describe('Optional calendar id to scope to.'),
});

/** Zod schema validating `create_task` input. */
export const createTaskInputSchema = z.object({
  title: z.string().min(1).describe('Task title.'),
  startAt: z
    .string()
    .optional()
    .describe('ISO 8601 start datetime; omit for a timeless todo.'),
  endAt: z
    .string()
    .optional()
    .describe('ISO 8601 end datetime; omit for an open-ended task.'),
  isAllDay: z.boolean().optional().describe('Mark the task all-day.'),
  notes: z.string().optional().describe('Optional notes.'),
  group: z
    .string()
    .optional()
    .describe(
      'Optional group name; if it does not exist, confirm before creating one.',
    ),
  recurrence: recurrenceInputSchema.optional(),
  requiresCompletion: z
    .boolean()
    .optional()
    .describe('Whether the task must be completed (todos default true).'),
  timezone: z
    .string()
    .optional()
    .describe(
      'Optional IANA timezone; omit to use the user timezone from context.',
    ),
  calendarId: z
    .string()
    .optional()
    .describe('Optional calendar id; omit to use the primary calendar.'),
});

/**
 * Maximum number of tasks one `create_tasks` batch call may carry. A larger ask
 * is rejected by Zod (`.max(...)`) as a recoverable validation error so the model
 * splits it, rather than the dispatcher attempting an unbounded fan-out.
 */
export const MAX_CREATE_TASKS_BATCH = 25;

/**
 * Zod schema validating `create_tasks` input: a non-empty, capped array of the
 * same per-item shape `create_task` accepts, so the dispatcher reuses the exact
 * single-create resolution + conflict logic per item (Story 2). The `.min(1)`
 * rejects an empty batch and `.max(...)` asks the model to split an over-cap one.
 */
export const createTasksInputSchema = z.object({
  tasks: z
    .array(createTaskInputSchema)
    .min(1)
    .max(MAX_CREATE_TASKS_BATCH)
    .describe(
      `The tasks to create, applied in order (1-${MAX_CREATE_TASKS_BATCH}). Each item is a full create_task input; split a larger list across calls.`,
    ),
});

/** Zod schema validating `update_task` input. */
export const updateTaskInputSchema = z.object({
  handle: z
    .string()
    .describe('Bracketed handle of the task to update, e.g. e2.'),
  title: z.string().min(1).optional().describe('New title.'),
  startAt: z.string().optional().describe('New ISO 8601 start datetime.'),
  endAt: z
    .string()
    .nullable()
    .optional()
    .describe('New ISO 8601 end datetime, or null to clear it.'),
  group: z.string().optional().describe('New group name.'),
  recurrence: recurrenceInputSchema.optional(),
  editScope: editScopeSchema.optional().describe(EDIT_SCOPE_DESCRIPTION),
});

/** Zod schema validating `complete_task` input. */
export const completeTaskInputSchema = z.object({
  handle: z.string().describe('Bracketed handle of the task, e.g. e2.'),
  completed: z
    .boolean()
    .optional()
    .describe('True to complete (default), false to reopen.'),
});

/** Zod schema validating `delete_task` input. */
export const deleteTaskInputSchema = z.object({
  handle: z
    .string()
    .describe('Bracketed handle of the task to delete, e.g. e2.'),
  editScope: editScopeSchema.optional().describe(EDIT_SCOPE_DESCRIPTION),
});

/** Zod schema validating `set_reminder` input. */
export const setReminderInputSchema = z.object({
  handle: z.string().describe('Bracketed handle of the task, e.g. e2.'),
  offsetMinutes: z
    .number()
    .int()
    .describe('Minutes relative to start; negative fires before (e.g. -15).'),
  channel: z
    .enum(['PUSH', 'TELEGRAM'])
    .optional()
    .describe('Delivery channel.'),
});

/** Zod schema validating `list_groups` input (no arguments). */
export const listGroupsInputSchema = z.object({});

/** Zod schema validating `create_group` input. */
export const createGroupInputSchema = z.object({
  name: z.string().min(1).describe('Group name.'),
  color: z.string().optional().describe('Optional color.'),
  icon: z.string().optional().describe('Optional icon.'),
});

/**
 * Maximum number of proposed slots one `check_availability` batch may carry. A
 * larger ask is rejected by Zod (`.max(...)`) as a recoverable validation error
 * so the model splits it across calls, rather than the tool probing an unbounded
 * number of windows in a single fetch.
 */
export const MAX_CHECK_AVAILABILITY_SLOTS = 25;

/**
 * Zod schema validating one proposed slot of a `check_availability` call: a
 * concrete `[startAt, endAt)` window to point-check, optionally scoped to a
 * calendar and optionally excluding a task from its own conflict scan. Each field
 * carries `.describe(...)` so the derived JSON schema steers the model. The tool
 * checks CONCRETE windows only — a recurrence rule is NOT a valid slot; the
 * model expands a repeating proposal into its concrete occurrences first.
 */
export const checkAvailabilitySlotSchema = z
  .object({
    startAt: z
      .string()
      .describe('ISO 8601 start of the proposed slot (inclusive).'),
    endAt: z
      .string()
      .describe('ISO 8601 end of the proposed slot (exclusive).'),
    calendarId: z
      .string()
      .optional()
      .describe('Optional calendar id to scope the check to.'),
    excludeTaskId: z
      .string()
      .optional()
      .describe(
        'Optional task id to exclude from its own conflict scan (e.g. when re-checking a move).',
      ),
  })
  .describe(
    'One concrete proposed time window to check. Pass a concrete start and end, never a recurrence rule.',
  );

/**
 * Zod schema validating `check_availability` input: a non-empty, capped array of
 * concrete proposed slots. The `.min(1)` rejects an empty batch and `.max(...)`
 * asks the model to split an over-cap one. Reuses the same conflict primitive the
 * write-time hold trusts (`TaskService.findOverlapping`), one call per slot.
 */
export const checkAvailabilityInputSchema = z.object({
  slots: z
    .array(checkAvailabilitySlotSchema)
    .min(1)
    .max(MAX_CHECK_AVAILABILITY_SLOTS)
    .describe(
      `The proposed time slots to check, in order (1-${MAX_CHECK_AVAILABILITY_SLOTS}). Each is a concrete window; split a larger list across calls.`,
    ),
});

/**
 * Maximum number of tappable quick-reply options an `ask_user` question may carry
 * (ADR 0010). Capped so the inline keyboard stays a single, scannable row; a
 * larger ask is rejected by Zod (`.max(...)`) as a recoverable validation error.
 */
export const MAX_ASK_USER_OPTIONS = 4;

/**
 * Zod schema validating one `ask_user` quick-reply option: a stable `id` echoed
 * back on the inline-keyboard callback (`ask:<row>:<id>`) and the human-facing
 * `label`. Each field carries `.describe(...)` so the derived JSON schema steers
 * the model toward short, distinct option keys.
 */
export const askUserOptionSchema = z.object({
  id: z
    .string()
    .min(1)
    .describe(
      'Stable short option key echoed back when the user taps it (e.g. "fri", "1h"). Keep it terse and unique within the question.',
    ),
  label: z
    .string()
    .min(1)
    .describe('Human-facing button text shown to the user (e.g. "Friday").'),
});

/**
 * Zod schema validating `ask_user` input (ADR 0010): a single clarifying
 * `question` and an OPTIONAL list of up to four tappable `options`. Omit
 * `options` for a plain free-text question. The tool itself performs NO database
 * work — it is a sentinel the tool loop recognizes as "suspend the turn and ask
 * this question", resuming on the user's answer.
 */
export const askUserInputSchema = z.object({
  question: z
    .string()
    .min(1)
    .describe(
      'The single, concise clarifying question to ask the user. The turn suspends here and resumes when the user answers.',
    ),
  options: z
    .array(askUserOptionSchema)
    .max(MAX_ASK_USER_OPTIONS)
    .optional()
    .describe(
      `Optional tappable quick-reply options (1-${MAX_ASK_USER_OPTIONS}). Offer them when the answer is one of a few clear choices; omit for an open free-text question.`,
    ),
});

/** Inferred type of a validated `ask_user` input object. */
export type AskUserInput = z.infer<typeof askUserInputSchema>;
