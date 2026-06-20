import {
  MAX_CREATE_TASKS_BATCH,
  ToolName,
  createTasksInputSchema,
} from '../tool-schemas';
import { buildTool } from '../tool.contract';
import { createTaskProperties } from './shared-json-schema';

/** Model-facing description for `create_tasks` (byte-identical to original). */
const CREATE_TASKS_PROMPT =
  'Create MANY tasks in one call, applied in the given order — prefer this over repeated create_task when the user asks for several at once (e.g. "create all seven driving lessons"). Each item is a full create_task input (timed event, all-day event, or todo, optionally recurring or grouped). Non-conflicting items are created immediately; any non-recurring timed item that overlaps an existing one is held for the user to confirm — the rest still commit, so a single overlap never aborts the batch. Up to 25 items per call: split a larger list across several calls.';

/**
 * `create_tasks` — batch create, fanning out over the host's per-item create
 * logic. A write (the host reports its own committed/attempted counts). Kept LAST
 * in the registry's stable order so the derived schema array matches today's
 * append-only order (ADR 0004 cache stability).
 */
export const createTasksTool = buildTool({
  name: ToolName.CREATE_TASKS,
  prompt: () => CREATE_TASKS_PROMPT,
  inputSchema: createTasksInputSchema,
  jsonSchema: {
    type: 'object',
    properties: {
      tasks: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_CREATE_TASKS_BATCH,
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
  isWrite: () => true,
  run: (input, context, host) => host.handleCreateTasks(input, context),
});
