import { ToolName, findFreeSlotsInputSchema } from '../tool-schemas';
import { buildTool } from '../tool.contract';

/** Model-facing description for `find_free_slots` (byte-identical to original). */
const FIND_FREE_SLOTS_PROMPT =
  'Find open time slots of at least the given duration within a range, around existing tasks.';

/**
 * `find_free_slots` — reads busy occurrences and returns the gaps. A
 * schedule-fetch, never a write.
 */
export const findFreeSlotsTool = buildTool({
  name: ToolName.FIND_FREE_SLOTS,
  prompt: () => FIND_FREE_SLOTS_PROMPT,
  inputSchema: findFreeSlotsInputSchema,
  jsonSchema: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'ISO 8601 start of the range.' },
      to: { type: 'string', description: 'ISO 8601 end of the range.' },
      durationMinutes: {
        type: 'integer',
        description: 'Required slot length in minutes.',
      },
      calendarId: {
        type: 'string',
        description: 'Optional calendar id to scope to.',
      },
    },
    required: ['from', 'to', 'durationMinutes'],
  },
  isScheduleFetch: () => true,
  run: (input, context, host) => host.handleFindFreeSlots(input, context),
});
