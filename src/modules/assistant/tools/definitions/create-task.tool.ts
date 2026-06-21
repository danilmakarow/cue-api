import { ToolName, createTaskInputSchema } from '../tool-schemas';
import { buildTool } from '../tool.contract';
import { createTaskProperties } from './shared-json-schema';

/** Model-facing description for `create_task`. */
const CREATE_TASK_PROMPT =
  'Create a timed event, an all-day event, or a todo (omit startAt for a todo with no time). Supports recurrence (one task, one rule) and an optional group by name. If the time overlaps an existing commitment the write is REFUSED with a recoverable error restating the clash — do NOT book over it unless the user explicitly authorized this; otherwise call ask_user. Only when the user has explicitly authorized booking over it, retry with confirmOverlap:true.';

/**
 * `create_task` — creates one timed/all-day event or todo, optionally recurring
 * or grouped. A write; an overlapping one-off is refused with a recoverable
 * default-deny error unless `confirmOverlap` is set (ADR 0011). Not a
 * schedule-fetch.
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
