import { ToolName, updateTaskInputSchema } from '../tool-schemas';
import { buildTool } from '../tool.contract';
import {
  editScopeJsonSchema,
  nullableColorJsonSchema,
  nullableRecurrenceJsonSchema,
} from './shared-json-schema';

/** Model-facing description for `update_task`. */
const UPDATE_TASK_PROMPT =
  'Update a task or occurrence by its handle (move its time, rename it, change its group or recurrence). For a repeating task, pass editScope; if you omit it you will be asked which scope. If a timed move overlaps an existing commitment the write is REFUSED with a recoverable error restating the clash — do NOT move onto it unless the user explicitly authorized this; otherwise call ask_user. Only when the user authorized it, retry with confirmOverlap:true.';

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
  isWrite: () => true,
  run: (input, context, host) => host.handleUpdateTask(input, context),
});
