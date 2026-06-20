import { ToolName, completeTaskInputSchema } from '../tool-schemas';
import { buildTool } from '../tool.contract';

/** Model-facing description for `complete_task` (byte-identical to original). */
const COMPLETE_TASK_PROMPT =
  'Mark a task or a single recurring occurrence complete or incomplete, by handle.';

/**
 * `complete_task` — toggles completion of a task or recurring occurrence by
 * handle. A write; not a schedule-fetch.
 */
export const completeTaskTool = buildTool({
  name: ToolName.COMPLETE_TASK,
  prompt: () => COMPLETE_TASK_PROMPT,
  inputSchema: completeTaskInputSchema,
  jsonSchema: {
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
  isWrite: () => true,
  run: (input, context, host) => host.handleCompleteTask(input, context),
});
