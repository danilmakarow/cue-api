import { ToolName, deleteTaskInputSchema } from '../tool-schemas';
import { buildTool } from '../tool.contract';
import { editScopeJsonSchema } from './shared-json-schema';

/** Model-facing description for `delete_task` (byte-identical to original). */
const DELETE_TASK_PROMPT =
  'Delete a task or series by handle, or skip a single occurrence with editScope:"this". For a repeating task without editScope you will be asked which scope.';

/**
 * `delete_task` — deletes a task/series, skips or truncates a recurring
 * occurrence by handle + scope in the host. A write; not a schedule-fetch.
 */
export const deleteTaskTool = buildTool({
  name: ToolName.DELETE_TASK,
  prompt: () => DELETE_TASK_PROMPT,
  inputSchema: deleteTaskInputSchema,
  jsonSchema: {
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
  isWrite: () => true,
  run: (input, context, host) => host.handleDeleteTask(input, context),
});
