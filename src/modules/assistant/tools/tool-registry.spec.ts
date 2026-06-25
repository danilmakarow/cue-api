import { z } from 'zod';

import { toolRegistry } from './tool-registry';
import { buildTool } from './tool.contract';
import { ToolSchema } from '@/modules/ai/ai.types';

/** A trivially-valid Zod schema for the `buildTool` fail-closed tests. */
const NOOP_SCHEMA = z.object({});

/**
 * The model-facing tool schemas EXACTLY as they were hand-written in
 * `ASSISTANT_TOOL_SCHEMAS` before the registry migration (the uncommitted
 * Phase A/B/C + Wave-1 state). This is the byte-equivalence oracle: the registry
 * derives `toSchemas()` from the single-sourced tool definitions, and this test
 * asserts the derived array is deep-equal — same names, descriptions, required
 * arrays, and every nested field description — and in the same STABLE order
 * (new tools appended last — `update_group` is the latest, FEATURE R5) so the
 * cached tool-defs prefix never shifts (ADR 0004). Any drift in a tool's prompt
 * or input_schema fails here.
 */
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

const editScopeJsonSchema = {
  type: 'string',
  enum: ['this', 'this_and_following', 'all'],
  description:
    'For a repeating task: which instances to affect. Omit to be asked which scope; pass only when the user is unambiguous.',
};

const COLOR_DESCRIPTION =
  'Color: a preset name (RED, ORANGE, YELLOW, GREEN, TEAL, BLUE, INDIGO, PURPLE, PINK, BROWN, GRAY) or a custom #RRGGBB hex.';

const colorJsonSchema = {
  type: 'string',
  description: COLOR_DESCRIPTION,
};

const nullableColorJsonSchema = {
  type: ['string', 'null'],
  description: `${COLOR_DESCRIPTION} Pass null to clear and inherit the group.`,
};

const nullableRecurrenceJsonSchema = {
  ...recurrenceJsonSchema,
  type: ['object', 'null'],
  description:
    'New recurrence rule, or null to stop repeating. Makes the task repeat as ONE task with a single rule — never create copies for future dates.',
};

const createTaskProperties = {
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
  color: {
    type: 'string',
    description:
      'Color: a preset name (RED, ORANGE, YELLOW, GREEN, TEAL, BLUE, INDIGO, PURPLE, PINK, BROWN, GRAY) or a custom #RRGGBB hex.',
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

const EXPECTED_SCHEMAS: ToolSchema[] = [
  {
    name: 'list_tasks',
    description:
      'List tasks in a date/time range and/or by group / completion. Returns lines prefixed with a bracketed handle like [e2] — use that handle to act on a task. A repeating task\'s line ends with a 🔁 marker giving its rule and end (e.g. "🔁 every Thu until 1 Aug"), "inherited from group \\"<name>\\"" when the rule comes from its group rather than the task itself, and "(edited)" when that one instance was individually changed; a line without 🔁 is a one-off. Use only for dates beyond the schedule already in context.',
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
    name: 'find_free_slots',
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
    name: 'create_task',
    description:
      'Create a timed event, an all-day event, or a todo (omit startAt for a todo with no time). Supports recurrence (one task, one rule) and an optional group by name. If the time overlaps an existing commitment the write is REFUSED with a recoverable error restating the clash — do NOT book over it unless the user explicitly authorized this; otherwise call ask_user. Only when the user has explicitly authorized booking over it, retry with confirmOverlap:true.',
    inputSchema: {
      type: 'object',
      properties: createTaskProperties,
      required: ['title'],
    },
  },
  {
    name: 'update_task',
    description:
      'Update a task or occurrence by its handle (move its time, rename it, change its group or recurrence). For a repeating task, pass editScope; if you omit it you will be asked which scope. If a timed move overlaps an existing commitment the write is REFUSED with a recoverable error restating the clash — do NOT move onto it unless the user explicitly authorized this; otherwise call ask_user. Only when the user authorized it, retry with confirmOverlap:true.',
    inputSchema: {
      type: 'object',
      properties: {
        handle: {
          type: 'string',
          description: 'Bracketed handle of the task to update, e.g. e2.',
        },
        title: { type: 'string', description: 'New title.' },
        startAt: {
          type: ['string', 'null'],
          description:
            'New ISO 8601 start datetime, or null to clear it (revert to a timeless todo).',
        },
        endAt: {
          type: ['string', 'null'],
          description: 'New ISO 8601 end datetime, or null to clear it.',
        },
        isAllDay: { type: 'boolean', description: 'Mark the task all-day.' },
        notes: {
          type: ['string', 'null'],
          description: 'New notes, or null to clear them.',
        },
        timezone: {
          type: 'string',
          description: 'New IANA timezone for the task (e.g. Europe/Berlin).',
        },
        group: {
          type: ['string', 'null'],
          description: 'New group name, or null to un-group the task.',
        },
        recurrence: nullableRecurrenceJsonSchema,
        requiresCompletion: {
          type: ['boolean', 'null'],
          description:
            'Set whether the task must be completed, or null to clear and inherit the group default.',
        },
        color: nullableColorJsonSchema,
        editScope: editScopeJsonSchema,
        confirmOverlap: {
          type: 'boolean',
          description:
            'Set true ONLY when the user explicitly authorized moving onto an existing commitment. Leave unset and an overlapping move is refused (ask the user first).',
        },
      },
      required: ['handle'],
    },
  },
  {
    name: 'complete_task',
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
    name: 'delete_task',
    description:
      'Delete a task or series by handle, or skip a single occurrence with editScope:"this". For a repeating task without editScope you will be asked which scope. Deleting is destructive and irreversible: you MUST ask the user to confirm first, then retry with confirmDelete:true. Leave confirmDelete unset and the delete is REFUSED with a recoverable error telling you to ask first — confirmOverlap and a standing allow-policy do NOT authorize a delete.',
    inputSchema: {
      type: 'object',
      properties: {
        handle: {
          type: 'string',
          description: 'Bracketed handle of the task to delete, e.g. e2.',
        },
        editScope: editScopeJsonSchema,
        confirmDelete: {
          type: 'boolean',
          description:
            'Set true ONLY after the user explicitly confirmed deleting this commitment. A delete is destructive: leave unset and it is refused (ask the user first). confirmOverlap and a standing allow-policy never authorize a delete.',
        },
      },
      required: ['handle'],
    },
  },
  {
    name: 'set_reminder',
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
    name: 'list_groups',
    description:
      "List the user's task groups so you know what exists before assigning or filtering by group.",
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'create_group',
    description:
      'Create a task group (e.g. a new "Home reno" project), optionally with a default color, default recurrence, and default completion-requirement inherited by its tasks. Confirm with the user before creating a group they did not explicitly ask for.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Group name.' },
        color: colorJsonSchema,
        icon: { type: 'string', description: 'Optional icon.' },
        recurrence: recurrenceJsonSchema,
        requiresCompletion: {
          type: 'boolean',
          description:
            'Default completion requirement inherited by tasks in this group.',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'create_tasks',
    description:
      'Create MANY tasks in one call, applied in the given order — prefer this over repeated create_task when the user asks for several at once (e.g. "create all seven driving lessons"). Each item is a full create_task input (timed event, all-day event, or todo, optionally recurring or grouped). Non-conflicting items are created immediately; any item that overlaps an existing commitment is REFUSED with a recoverable error restating the clash (the rest still commit, so one overlap never aborts the batch) — do NOT book over a clash unless the user explicitly authorized it; otherwise ask_user, then retry that item with confirmOverlap:true. Up to 25 items per call: split a larger list across several calls.',
    inputSchema: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          minItems: 1,
          maxItems: 25,
          description:
            'The tasks to create, applied in order (1-25). Each item is a full create_task input; split a larger list across calls.',
          items: {
            type: 'object',
            properties: createTaskProperties,
            required: ['title'],
          },
        },
      },
      required: ['tasks'],
    },
  },
  {
    name: 'check_availability',
    description:
      'Check whether a list of specific proposed time slots are free, in ONE call — use this instead of probing slots one at a time. Each slot is a concrete window (startAt + endAt); returns a per-slot verdict (FREE, or BUSY with the conflicting tasks tagged by their [eN] handle so you can act on them). Up to 25 slots per call. This checks CONCRETE windows only: it does NOT accept a recurrence rule as a slot — expand a repeating proposal into its individual occurrences and pass those. It is a read, never a write: a "free" verdict here matches what a later create would see, but it does not book anything.',
    inputSchema: {
      type: 'object',
      properties: {
        slots: {
          type: 'array',
          minItems: 1,
          maxItems: 25,
          description:
            'The proposed time slots to check, in order (1-25). Each is a concrete window; split a larger list across calls.',
          items: {
            type: 'object',
            description:
              'One concrete proposed time window to check. Pass a concrete start and end, never a recurrence rule.',
            properties: {
              startAt: {
                type: 'string',
                description: 'ISO 8601 start of the proposed slot (inclusive).',
              },
              endAt: {
                type: 'string',
                description: 'ISO 8601 end of the proposed slot (exclusive).',
              },
              calendarId: {
                type: 'string',
                description: 'Optional calendar id to scope the check to.',
              },
              excludeTaskId: {
                type: 'string',
                description:
                  'Optional task id to exclude from its own conflict scan (e.g. when re-checking a move).',
              },
            },
            required: ['startAt', 'endAt'],
          },
        },
      },
      required: ['slots'],
    },
  },
  {
    name: 'ask_user',
    description:
      'Ask the user ONE concise clarifying question and pause — use this when you genuinely need a missing detail (a time, a choice, a confirmation) before you can act, instead of guessing. Optionally offer up to 4 tappable quick-reply options ({ id, label }) when the answer is one of a few clear choices; omit them for an open free-text question. The turn SUSPENDS here: your question is sent to the user, and the same task automatically resumes with their answer fed back to you (you may then ask again or proceed). Ask at most one question at a time, and only when the answer would actually change what you do.',
    inputSchema: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description:
            'The single, concise clarifying question to ask the user. The turn suspends here and resumes when the user answers.',
        },
        options: {
          type: 'array',
          maxItems: 4,
          description:
            'Optional tappable quick-reply options (1-4). Offer them when the answer is one of a few clear choices; omit for an open free-text question.',
          items: {
            type: 'object',
            properties: {
              id: {
                type: 'string',
                description:
                  'Stable short option key echoed back when the user taps it (e.g. "fri", "1h"). Keep it terse and unique within the question.',
              },
              label: {
                type: 'string',
                description:
                  'Human-facing button text shown to the user (e.g. "Friday").',
              },
            },
            required: ['id', 'label'],
          },
        },
      },
      required: ['question'],
    },
  },
  {
    name: 'update_group',
    description:
      'Update an existing task group by its name: rename it, or change its default color, icon, recurrence, or completion requirement (the defaults its tasks inherit). Pass null for color / icon / recurrence / requiresCompletion to clear that group default. Resolve the group via list_groups first if you are unsure of the exact name.',
    inputSchema: {
      type: 'object',
      properties: {
        group: {
          type: 'string',
          description: 'Existing group name to update.',
        },
        name: { type: 'string', description: 'New group name (a rename).' },
        sortOrder: {
          type: 'integer',
          description: 'New sort position among groups (lower sorts first).',
        },
        color: nullableColorJsonSchema,
        icon: {
          type: ['string', 'null'],
          description: 'New icon, or null to clear it.',
        },
        recurrence: nullableRecurrenceJsonSchema,
        requiresCompletion: {
          type: ['boolean', 'null'],
          description:
            'Set the group default completion requirement, or null to clear it.',
        },
      },
      required: ['group'],
    },
  },
];

describe('ToolRegistry.toSchemas — byte-equivalence with the prior hand-written schemas', () => {
  it('derives the model-facing schema array deep-equal to the original ASSISTANT_TOOL_SCHEMAS', async () => {
    const derived = await toolRegistry.toSchemas();

    expect(derived).toEqual(EXPECTED_SCHEMAS);
  });

  it('serializes to the exact same JSON bytes (cache-prefix stability, ADR 0004)', async () => {
    const derived = await toolRegistry.toSchemas();

    expect(JSON.stringify(derived)).toBe(JSON.stringify(EXPECTED_SCHEMAS));
  });

  it('keeps the stable append-only tool order with create_tasks last', async () => {
    const derived = await toolRegistry.toSchemas();

    expect(derived.map((tool) => tool.name)).toEqual([
      'list_tasks',
      'find_free_slots',
      'create_task',
      'update_task',
      'complete_task',
      'delete_task',
      'set_reminder',
      'list_groups',
      'create_group',
      'create_tasks',
      'check_availability',
      'ask_user',
      'update_group',
    ]);
  });

  it('carries the expected nested field descriptions for create_task (representative)', async () => {
    const derived = await toolRegistry.toSchemas();
    const createTask = derived.find((tool) => tool.name === 'create_task');
    const properties = createTask?.inputSchema.properties as Record<
      string,
      { description?: string }
    >;
    const recurrence = properties.recurrence as {
      properties: Record<string, { description?: string }>;
    };

    expect(properties.title.description).toBe('Task title.');
    expect(properties.calendarId.description).toBe(
      'Optional calendar id; omit to use the primary calendar.',
    );
    expect(recurrence.properties.frequency.description).toBe(
      'How often the task repeats.',
    );
    expect(recurrence.properties.count.description).toBe(
      'Number of occurrences; required for COUNT.',
    );
  });
});

describe('ToolRegistry derived accounting sets', () => {
  it('derives the write tools from each tool isWrite() predicate', () => {
    expect([...toolRegistry.writeNames()].sort()).toEqual(
      [
        'create_group',
        'create_task',
        'create_tasks',
        'complete_task',
        'delete_task',
        'update_group',
        'update_task',
      ].sort(),
    );
  });

  it('derives the schedule-fetch tools from each tool isScheduleFetch() predicate', () => {
    expect([...toolRegistry.scheduleFetchNames()].sort()).toEqual(
      ['check_availability', 'find_free_slots', 'list_tasks'].sort(),
    );
  });
});

describe('buildTool', () => {
  it('spreads TOOL_DEFAULTS first so an omitted predicate fails closed', () => {
    const tool = buildTool({
      name: 'noop',
      prompt: () => 'noop',
      inputSchema: NOOP_SCHEMA,
      run: () => Promise.resolve({ content: 'ok' }),
    });

    expect(tool.isWrite()).toBe(false);
    expect(tool.isScheduleFetch()).toBe(false);
  });

  it('lets a definition override a fail-closed default', () => {
    const tool = buildTool({
      name: 'writer',
      prompt: () => 'writer',
      inputSchema: NOOP_SCHEMA,
      isWrite: () => true,
      run: () => Promise.resolve({ content: 'ok' }),
    });

    expect(tool.isWrite()).toBe(true);
    expect(tool.isScheduleFetch()).toBe(false);
  });
});
