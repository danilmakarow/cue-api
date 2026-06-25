import { ToolName, updateGroupInputSchema } from '../tool-schemas';
import { buildTool } from '../tool.contract';
import {
  nullableColorJsonSchema,
  nullableRecurrenceJsonSchema,
} from './shared-json-schema';

/** Model-facing description for `update_group`. */
const UPDATE_GROUP_PROMPT =
  'Update an existing task group by its name: rename it, or change its default color, icon, recurrence, or completion requirement (the defaults its tasks inherit). Pass null for color / icon / recurrence / requiresCompletion to clear that group default. Resolve the group via list_groups first if you are unsure of the exact name.';

/**
 * `update_group` — renames a group and/or changes its inherited defaults (color,
 * icon, recurrence, completion-requirement) by name. A write; not a
 * schedule-fetch. Appended LAST in the registry (ADR 0004 append-only order).
 */
export const updateGroupTool = buildTool({
  name: ToolName.UPDATE_GROUP,
  prompt: () => UPDATE_GROUP_PROMPT,
  inputSchema: updateGroupInputSchema,
  // Intentionally NOT editable here: defaultNotificationStrategyId (delivery
  // not wired). Do not add it.
  jsonSchema: {
    type: 'object',
    properties: {
      group: {
        type: 'string',
        description: 'Existing group name to update.',
      },
      name: { type: 'string', description: 'New group name (a rename).' },
      sortOrder: {
        type: 'integer',
        description: 'New sort position among groups (lower sorts first).',
      },
      color: nullableColorJsonSchema,
      icon: {
        type: ['string', 'null'],
        description: 'New icon, or null to clear it.',
      },
      recurrence: nullableRecurrenceJsonSchema,
      requiresCompletion: {
        type: ['boolean', 'null'],
        description:
          'Set the group default completion requirement, or null to clear it.',
      },
    },
    required: ['group'],
  },
  isWrite: () => true,
  run: (input, context, host) => host.handleUpdateGroup(input, context),
});
