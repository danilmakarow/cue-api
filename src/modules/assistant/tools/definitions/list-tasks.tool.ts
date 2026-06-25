import { ToolName, listTasksInputSchema } from '../tool-schemas';
import { buildTool } from '../tool.contract';

/**
 * Model-facing description for `list_tasks`. Documents that returned lines carry
 * inline recurrence context (rule / source / per-instance override) so the model
 * can read it without an extra call — see the trailing 🔁 marker each line may
 * carry.
 */
const LIST_TASKS_PROMPT =
  'List tasks in a date/time range and/or by group / completion. Returns lines prefixed with a bracketed handle like [e2] — use that handle to act on a task. A repeating task\'s line ends with a 🔁 marker giving its rule and end (e.g. "🔁 every Thu until 1 Aug"), "inherited from group \\"<name>\\"" when the rule comes from its group rather than the task itself, and "(edited)" when that one instance was individually changed; a line without 🔁 is a one-off. Use only for dates beyond the schedule already in context.';

/**
 * `list_tasks` — reads the schedule in a range / by group. A schedule-fetch
 * (counts against the per-turn read cap), never a write. Delegates to the host's
 * existing handler so behavior is unchanged.
 */
export const listTasksTool = buildTool({
  name: ToolName.LIST_TASKS,
  prompt: () => LIST_TASKS_PROMPT,
  inputSchema: listTasksInputSchema,
  jsonSchema: {
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
  isScheduleFetch: () => true,
  run: (input, context, host) => host.handleListTasks(input, context),
});
