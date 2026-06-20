import { ToolName, createGroupInputSchema } from '../tool-schemas';
import { buildTool } from '../tool.contract';

/** Model-facing description for `create_group` (byte-identical to original). */
const CREATE_GROUP_PROMPT =
  'Create a task group (e.g. a new "Home reno" project). Confirm with the user before creating a group they did not explicitly ask for.';

/**
 * `create_group` — creates a task group in the user's primary calendar. A write;
 * not a schedule-fetch.
 */
export const createGroupTool = buildTool({
  name: ToolName.CREATE_GROUP,
  prompt: () => CREATE_GROUP_PROMPT,
  inputSchema: createGroupInputSchema,
  jsonSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Group name.' },
      color: { type: 'string', description: 'Optional color.' },
      icon: { type: 'string', description: 'Optional icon.' },
    },
    required: ['name'],
  },
  isWrite: () => true,
  run: (input, context, host) => host.handleCreateGroup(input, context),
});
