import { ToolName, updateTaskInputSchema } from '../tool-schemas';
import { buildTool } from '../tool.contract';
import {
  editScopeJsonSchema,
  recurrenceJsonSchema,
} from './shared-json-schema';

/** Model-facing description for `update_task` (byte-identical to original). */
const UPDATE_TASK_PROMPT =
  'Update a task or occurrence by its handle (move its time, rename it, change its group or recurrence). For a repeating task, pass editScope; if you omit it you will be asked which scope. Overlaps on a one-off move are handled by the confirmation flow.';

/**
 * `update_task` — moves / renames / regroups a task or occurrence by handle,
 * branching on recurrence + edit scope in the host. A write; not a
 * schedule-fetch.
 */
export const updateTaskTool = buildTool({
  name: ToolName.UPDATE_TASK,
  prompt: () => UPDATE_TASK_PROMPT,
  inputSchema: updateTaskInputSchema,
  jsonSchema: {
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
  isWrite: () => true,
  run: (input, context, host) => host.handleUpdateTask(input, context),
});
