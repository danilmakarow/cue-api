import { ToolName, createTaskInputSchema } from '../tool-schemas';
import { buildTool } from '../tool.contract';
import { createTaskProperties } from './shared-json-schema';

/** Model-facing description for `create_task` (byte-identical to original). */
const CREATE_TASK_PROMPT =
  'Create a timed event, an all-day event, or a todo (omit startAt for a todo with no time). Supports recurrence (one task, one rule) and an optional group by name. A non-recurring timed task that overlaps an existing one is held for the user to confirm — do not resolve conflicts yourself.';

/**
 * `create_task` — creates one timed/all-day event or todo, optionally recurring
 * or grouped. A write; a conflicting one-off is held for confirmation by the
 * host. Not a schedule-fetch.
 */
export const createTaskTool = buildTool({
  name: ToolName.CREATE_TASK,
  prompt: () => CREATE_TASK_PROMPT,
  inputSchema: createTaskInputSchema,
  jsonSchema: {
    type: 'object',
    properties: createTaskProperties,
    required: ['title'],
  },
  isWrite: () => true,
  run: (input, context, host) => host.handleCreateTask(input, context),
});
