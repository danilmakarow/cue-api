import { ToolName, listGroupsInputSchema } from '../tool-schemas';
import { buildTool } from '../tool.contract';

/** Model-facing description for `list_groups` (byte-identical to original). */
const LIST_GROUPS_PROMPT =
  "List the user's task groups so you know what exists before assigning or filtering by group.";

/**
 * `list_groups` — lists the user's task groups by name. A read; neither a write
 * nor a schedule-fetch (it reads groups, not the schedule, so it does not count
 * against the schedule-fetch cap — matching today's membership).
 */
export const listGroupsTool = buildTool({
  name: ToolName.LIST_GROUPS,
  prompt: () => LIST_GROUPS_PROMPT,
  inputSchema: listGroupsInputSchema,
  jsonSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  run: (input, context, host) => host.handleListGroups(input, context),
});
