import { z } from 'zod';

import { ToolSchema } from '@/modules/ai/ai.types';
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
  UPDATE_TASK: 'update_task',
  COMPLETE_TASK: 'complete_task',
  DELETE_TASK: 'delete_task',
  SET_REMINDER: 'set_reminder',
  LIST_GROUPS: 'list_groups',
  CREATE_GROUP: 'create_group',
} as const;

/** Union of the tool name literals. */
export type ToolNameValue = (typeof ToolName)[keyof typeof ToolName];

/**
 * Tools that read schedule data and therefore count against the per-turn
 * schedule-fetch read cap (ADR 0006 layer 3).
 */
export const SCHEDULE_FETCH_TOOLS: ReadonlySet<string> = new Set([
  ToolName.LIST_TASKS,
  ToolName.FIND_FREE_SLOTS,
]);

/**
 * Tools that actually persist a calendar mutation. The orchestrator counts a
 * successful, non-held call to any of these as a committed write, so it can tell
 * whether a turn that *claimed* to act actually changed anything (the
 * "claimed-action but no write" guard) and report an accurate "saved N changes".
 *
 * Reads (`list_tasks`, `find_free_slots`, `list_groups`) are excluded — and so
 * is `set_reminder`: its handler is a no-op stub today ("reminders coming soon")
 * that writes nothing, so counting it would both mask a fabricated reminder
 * claim and inflate the saved-changes count. Re-add it when reminders persist.
 */
export const WRITE_TOOLS: ReadonlySet<string> = new Set([
  ToolName.CREATE_TASK,
  ToolName.UPDATE_TASK,
  ToolName.COMPLETE_TASK,
  ToolName.DELETE_TASK,
  ToolName.CREATE_GROUP,
]);

/** The three recurring-edit scopes the model may pass on update / delete. */
export const editScopeSchema = z.enum(['this', 'this_and_following', 'all']);

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
    frequency: z.nativeEnum(RecurrenceFrequency),
    interval: z.number().int().min(1).optional(),
    byWeekday: z.array(z.number().int().min(0).max(6)).nonempty().optional(),
    byMonthDay: z.array(z.number().int().min(1).max(31)).nonempty().optional(),
    byMonth: z.array(z.number().int().min(1).max(12)).nonempty().optional(),
    endType: z.nativeEnum(RecurrenceEndType).optional(),
    endDate: z.string().optional(),
    count: z.number().int().min(1).optional(),
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
  from: z.string().optional(),
  to: z.string().optional(),
  group: z.string().optional(),
  includeCompleted: z.boolean().optional(),
  onlyTodos: z.boolean().optional(),
});

/** Zod schema validating `find_free_slots` input. */
export const findFreeSlotsInputSchema = z.object({
  from: z.string(),
  to: z.string(),
  durationMinutes: z.number().int().positive(),
  calendarId: z.string().optional(),
});

/** Zod schema validating `create_task` input. */
export const createTaskInputSchema = z.object({
  title: z.string().min(1),
  startAt: z.string().optional(),
  endAt: z.string().optional(),
  isAllDay: z.boolean().optional(),
  notes: z.string().optional(),
  group: z.string().optional(),
  recurrence: recurrenceInputSchema.optional(),
  requiresCompletion: z.boolean().optional(),
  timezone: z.string().optional(),
  calendarId: z.string().optional(),
});

/** Zod schema validating `update_task` input. */
export const updateTaskInputSchema = z.object({
  handle: z.string(),
  title: z.string().min(1).optional(),
  startAt: z.string().optional(),
  endAt: z.string().nullable().optional(),
  group: z.string().optional(),
  recurrence: recurrenceInputSchema.optional(),
  editScope: editScopeSchema.optional(),
});

/** Zod schema validating `complete_task` input. */
export const completeTaskInputSchema = z.object({
  handle: z.string(),
  completed: z.boolean().optional(),
});

/** Zod schema validating `delete_task` input. */
export const deleteTaskInputSchema = z.object({
  handle: z.string(),
  editScope: editScopeSchema.optional(),
});

/** Zod schema validating `set_reminder` input. */
export const setReminderInputSchema = z.object({
  handle: z.string(),
  offsetMinutes: z.number().int(),
  channel: z.enum(['PUSH', 'TELEGRAM']).optional(),
});

/** Zod schema validating `list_groups` input (no arguments). */
export const listGroupsInputSchema = z.object({});

/** Zod schema validating `create_group` input. */
export const createGroupInputSchema = z.object({
  name: z.string().min(1),
  color: z.string().optional(),
  icon: z.string().optional(),
});

/** JSON-Schema fragment describing the shared `recurrence` object. */
const recurrenceJsonSchema = {
  type: 'object',
  description:
    'Makes the task repeat as ONE task with a single rule — never create copies for future dates.',
  properties: {
    frequency: {
      type: 'string',
      enum: ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'],
      description: 'How often the task repeats.',
    },
    interval: {
      type: 'integer',
      description: 'Repeat every N periods (default 1). E.g. 2 = every other.',
    },
    byWeekday: {
      type: 'array',
      items: { type: 'integer' },
      description:
        'Weekday ordinals 0=Mon … 6=Sun (e.g. [0,1,2,3,4] weekdays).',
    },
    byMonthDay: {
      type: 'array',
      items: { type: 'integer' },
      description: 'Days of the month (1-31).',
    },
    byMonth: {
      type: 'array',
      items: { type: 'integer' },
      description: 'Months (1-12).',
    },
    endType: {
      type: 'string',
      enum: ['NEVER', 'UNTIL_DATE', 'COUNT'],
      description: 'When the series ends.',
    },
    endDate: {
      type: 'string',
      description: 'ISO date the series ends on; required for UNTIL_DATE.',
    },
    count: {
      type: 'integer',
      description: 'Number of occurrences; required for COUNT.',
    },
  },
  required: ['frequency'],
};

/** JSON-Schema fragment describing the recurring-edit scope. */
const editScopeJsonSchema = {
  type: 'string',
  enum: ['this', 'this_and_following', 'all'],
  description:
    'For a repeating task: which instances to affect. Omit to be asked which scope; pass only when the user is unambiguous.',
};

/**
 * The provider-neutral tool definitions sent to the model (prompt block 2 —
 * ADR 0004). The LAST entry carries `cacheBoundary` so the connector closes the
 * shared tool-definitions prefix (cache breakpoint #1). JSON-Schema input
 * shapes mirror the Zod validators the dispatcher enforces.
 */
export const ASSISTANT_TOOL_SCHEMAS: ToolSchema[] = [
  {
    name: ToolName.LIST_TASKS,
    description:
      'List tasks in a date/time range and/or by group / completion. Returns lines prefixed with a bracketed handle like [e2] — use that handle to act on a task. Use only for dates beyond the schedule already in context.',
    inputSchema: {
      type: 'object',
      properties: {
        from: {
          type: 'string',
          description:
            'ISO 8601 start of the range (inclusive). Defaults to today.',
        },
        to: {
          type: 'string',
          description:
            'ISO 8601 end of the range (exclusive). Defaults to a week out.',
        },
        group: {
          type: 'string',
          description: 'Optional group name to filter by.',
        },
        includeCompleted: {
          type: 'boolean',
          description: 'Include completed tasks (default false).',
        },
        onlyTodos: {
          type: 'boolean',
          description: 'Return only timeless todos (no start time).',
        },
      },
      required: [],
    },
  },
  {
    name: ToolName.FIND_FREE_SLOTS,
    description:
      'Find open time slots of at least the given duration within a range, around existing tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'ISO 8601 start of the range.' },
        to: { type: 'string', description: 'ISO 8601 end of the range.' },
        durationMinutes: {
          type: 'integer',
          description: 'Required slot length in minutes.',
        },
        calendarId: {
          type: 'string',
          description: 'Optional calendar id to scope to.',
        },
      },
      required: ['from', 'to', 'durationMinutes'],
    },
  },
  {
    name: ToolName.CREATE_TASK,
    description:
      'Create a timed event, an all-day event, or a todo (omit startAt for a todo with no time). Supports recurrence (one task, one rule) and an optional group by name. A non-recurring timed task that overlaps an existing one is held for the user to confirm — do not resolve conflicts yourself.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Task title.' },
        startAt: {
          type: 'string',
          description: 'ISO 8601 start datetime; omit for a timeless todo.',
        },
        endAt: {
          type: 'string',
          description: 'ISO 8601 end datetime; omit for an open-ended task.',
        },
        isAllDay: {
          type: 'boolean',
          description: 'Mark the task all-day.',
        },
        notes: { type: 'string', description: 'Optional notes.' },
        group: {
          type: 'string',
          description:
            'Optional group name; if it does not exist, confirm before creating one.',
        },
        recurrence: recurrenceJsonSchema,
        requiresCompletion: {
          type: 'boolean',
          description:
            'Whether the task must be completed (todos default true).',
        },
        timezone: {
          type: 'string',
          description:
            'Optional IANA timezone; omit to use the user timezone from context.',
        },
        calendarId: {
          type: 'string',
          description:
            'Optional calendar id; omit to use the primary calendar.',
        },
      },
      required: ['title'],
    },
  },
  {
    name: ToolName.UPDATE_TASK,
    description:
      'Update a task or occurrence by its handle (move its time, rename it, change its group or recurrence). For a repeating task, pass editScope; if you omit it you will be asked which scope. Overlaps on a one-off move are handled by the confirmation flow.',
    inputSchema: {
      type: 'object',
      properties: {
        handle: {
          type: 'string',
          description: 'Bracketed handle of the task to update, e.g. e2.',
        },
        title: { type: 'string', description: 'New title.' },
        startAt: {
          type: 'string',
          description: 'New ISO 8601 start datetime.',
        },
        endAt: {
          type: ['string', 'null'],
          description: 'New ISO 8601 end datetime, or null to clear it.',
        },
        group: { type: 'string', description: 'New group name.' },
        recurrence: recurrenceJsonSchema,
        editScope: editScopeJsonSchema,
      },
      required: ['handle'],
    },
  },
  {
    name: ToolName.COMPLETE_TASK,
    description:
      'Mark a task or a single recurring occurrence complete or incomplete, by handle.',
    inputSchema: {
      type: 'object',
      properties: {
        handle: {
          type: 'string',
          description: 'Bracketed handle of the task, e.g. e2.',
        },
        completed: {
          type: 'boolean',
          description: 'True to complete (default), false to reopen.',
        },
      },
      required: ['handle'],
    },
  },
  {
    name: ToolName.DELETE_TASK,
    description:
      'Delete a task or series by handle, or skip a single occurrence with editScope:"this". For a repeating task without editScope you will be asked which scope.',
    inputSchema: {
      type: 'object',
      properties: {
        handle: {
          type: 'string',
          description: 'Bracketed handle of the task to delete, e.g. e2.',
        },
        editScope: editScopeJsonSchema,
      },
      required: ['handle'],
    },
  },
  {
    name: ToolName.SET_REMINDER,
    description: 'Set a reminder offset on a task by handle.',
    inputSchema: {
      type: 'object',
      properties: {
        handle: {
          type: 'string',
          description: 'Bracketed handle of the task, e.g. e2.',
        },
        offsetMinutes: {
          type: 'integer',
          description:
            'Minutes relative to start; negative fires before (e.g. -15).',
        },
        channel: {
          type: 'string',
          enum: ['PUSH', 'TELEGRAM'],
          description: 'Delivery channel.',
        },
      },
      required: ['handle', 'offsetMinutes'],
    },
  },
  {
    name: ToolName.LIST_GROUPS,
    description:
      "List the user's task groups so you know what exists before assigning or filtering by group.",
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: ToolName.CREATE_GROUP,
    description:
      'Create a task group (e.g. a new "Home reno" project). Confirm with the user before creating a group they did not explicitly ask for.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Group name.' },
        color: { type: 'string', description: 'Optional color.' },
        icon: { type: 'string', description: 'Optional icon.' },
      },
      required: ['name'],
    },
  },
];
