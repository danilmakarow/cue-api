import { ToolName, createGroupInputSchema } from '../tool-schemas';
import { buildTool } from '../tool.contract';
import { colorJsonSchema, recurrenceJsonSchema } from './shared-json-schema';

/** Model-facing description for `create_group`. */
const CREATE_GROUP_PROMPT =
  'Create a task group (e.g. a new "Home reno" project), optionally with a default color, default recurrence, and default completion-requirement inherited by its tasks. Confirm with the user before creating a group they did not explicitly ask for.';

/**
 * `create_group` — creates a task group in the user's primary calendar, with
 * optional inherited defaults (color, recurrence, completion-requirement). A
 * write; not a schedule-fetch.
 */
export const createGroupTool = buildTool({
  name: ToolName.CREATE_GROUP,
  prompt: () => CREATE_GROUP_PROMPT,
  inputSchema: createGroupInputSchema,
  jsonSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Group name.' },
      color: colorJsonSchema,
      icon: { type: 'string', description: 'Optional icon.' },
      recurrence: recurrenceJsonSchema,
      requiresCompletion: {
        type: 'boolean',
        description:
          'Default completion requirement inherited by tasks in this group.',
      },
    },
    required: ['name'],
  },
  isWrite: () => true,
  run: (input, context, host) => host.handleCreateGroup(input, context),
});
