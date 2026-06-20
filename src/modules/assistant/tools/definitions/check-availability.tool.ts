import {
  MAX_CHECK_AVAILABILITY_SLOTS,
  ToolName,
  checkAvailabilityInputSchema,
} from '../tool-schemas';
import { buildTool } from '../tool.contract';

/** Model-facing description for `check_availability`. */
const CHECK_AVAILABILITY_PROMPT =
  'Check whether a list of specific proposed time slots are free, in ONE call — use this instead of probing slots one at a time. Each slot is a concrete window (startAt + endAt); returns a per-slot verdict (FREE, or BUSY with the conflicting tasks tagged by their [eN] handle so you can act on them). Up to 25 slots per call. This checks CONCRETE windows only: it does NOT accept a recurrence rule as a slot — expand a repeating proposal into its individual occurrences and pass those. It is a read, never a write: a "free" verdict here matches what a later create would see, but it does not book anything.';

/**
 * `check_availability` — batch read that point-checks each proposed window
 * against existing events via the SAME conflict primitive the write-time hold
 * uses (`TaskService.findOverlapping`), one call per slot with that slot's exact
 * bounds. A schedule-fetch (one batch call = one of the five fetches), never a
 * write. Appended LAST in the registry's stable order so the derived schema array
 * stays byte-order-stable for the ADR-0004 cache prefix.
 */
export const checkAvailabilityTool = buildTool({
  name: ToolName.CHECK_AVAILABILITY,
  prompt: () => CHECK_AVAILABILITY_PROMPT,
  inputSchema: checkAvailabilityInputSchema,
  jsonSchema: {
    type: 'object',
    properties: {
      slots: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_CHECK_AVAILABILITY_SLOTS,
        description:
          'The proposed time slots to check, in order (1-25). Each is a concrete window; split a larger list across calls.',
        items: {
          type: 'object',
          description:
            'One concrete proposed time window to check. Pass a concrete start and end, never a recurrence rule.',
          properties: {
            startAt: {
              type: 'string',
              description: 'ISO 8601 start of the proposed slot (inclusive).',
            },
            endAt: {
              type: 'string',
              description: 'ISO 8601 end of the proposed slot (exclusive).',
            },
            calendarId: {
              type: 'string',
              description: 'Optional calendar id to scope the check to.',
            },
            excludeTaskId: {
              type: 'string',
              description:
                'Optional task id to exclude from its own conflict scan (e.g. when re-checking a move).',
            },
          },
          required: ['startAt', 'endAt'],
        },
      },
    },
    required: ['slots'],
  },
  isScheduleFetch: () => true,
  run: (input, context, host) => host.handleCheckAvailability(input, context),
});
