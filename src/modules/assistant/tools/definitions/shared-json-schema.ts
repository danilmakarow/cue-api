import { ToolJsonSchema } from '../tool.contract';

/**
 * Verbatim model-facing JSON-Schema fragment for the shared `recurrence` object,
 * reused by `create_task`, `create_tasks`, and `update_task`. Byte-identical to
 * the original hand-written fragment so the cached tool-defs prefix is unchanged
 * (ADR 0004). The Zod `recurrenceInputSchema` is the validation source of truth;
 * this is its model-facing mirror.
 */
export const recurrenceJsonSchema: ToolJsonSchema = {
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

/** Verbatim model-facing JSON-Schema fragment for the recurring-edit scope. */
export const editScopeJsonSchema: ToolJsonSchema = {
  type: 'string',
  enum: ['this', 'this_and_following', 'all'],
  description:
    'For a repeating task: which instances to affect. Omit to be asked which scope; pass only when the user is unambiguous.',
};

/**
 * Verbatim model-facing JSON-Schema `properties` for one create item, shared by
 * `create_task` (its top-level shape) and `create_tasks` (its array `items`).
 * Single-sourced so the two never drift, byte-identical to the original.
 */
export const createTaskProperties: ToolJsonSchema = {
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
    description: 'Whether the task must be completed (todos default true).',
  },
  timezone: {
    type: 'string',
    description:
      'Optional IANA timezone; omit to use the user timezone from context.',
  },
  calendarId: {
    type: 'string',
    description: 'Optional calendar id; omit to use the primary calendar.',
  },
  confirmOverlap: {
    type: 'boolean',
    description:
      'Set true ONLY when the user explicitly authorized booking over an existing commitment. Leave unset and an overlapping write is refused (ask the user first).',
  },
};
