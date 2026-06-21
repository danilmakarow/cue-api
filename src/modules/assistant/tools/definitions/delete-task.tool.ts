import { ToolName, deleteTaskInputSchema } from '../tool-schemas';
import { buildTool } from '../tool.contract';
import { editScopeJsonSchema } from './shared-json-schema';

/** Model-facing description for `delete_task`. */
const DELETE_TASK_PROMPT =
  'Delete a task or series by handle, or skip a single occurrence with editScope:"this". For a repeating task without editScope you will be asked which scope. Deleting is destructive and irreversible: you MUST ask the user to confirm first, then retry with confirmDelete:true. Leave confirmDelete unset and the delete is REFUSED with a recoverable error telling you to ask first — confirmOverlap and a standing allow-policy do NOT authorize a delete.';

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
      confirmDelete: {
        type: 'boolean',
        description:
          'Set true ONLY after the user explicitly confirmed deleting this commitment. A delete is destructive: leave unset and it is refused (ask the user first). confirmOverlap and a standing allow-policy never authorize a delete.',
      },
    },
    required: ['handle'],
  },
  isWrite: () => true,
  run: (input, context, host) => host.handleDeleteTask(input, context),
});
