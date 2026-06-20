import { ToolName, setReminderInputSchema } from '../tool-schemas';
import { buildTool } from '../tool.contract';

/** Model-facing description for `set_reminder` (byte-identical to original). */
const SET_REMINDER_PROMPT = 'Set a reminder offset on a task by handle.';

/**
 * `set_reminder` — resolves the handle and returns a "coming soon" notice today
 * (delivery is owned by the notification-delivery spec). Neither a write nor a
 * schedule-fetch (its handler persists nothing), so both predicates keep the
 * fail-closed default. The host handler is synchronous; `Promise.resolve` lifts
 * it into the uniform async `run` contract.
 */
export const setReminderTool = buildTool({
  name: ToolName.SET_REMINDER,
  prompt: () => SET_REMINDER_PROMPT,
  inputSchema: setReminderInputSchema,
  jsonSchema: {
    type: 'object',
    properties: {
      handle: {
        type: 'string',
        description: 'Bracketed handle of the task, e.g. e2.',
      },
      offsetMinutes: {
        type: 'integer',
        description:
          'Minutes relative to start; negative fires before (e.g. -15).',
      },
      channel: {
        type: 'string',
        enum: ['PUSH', 'TELEGRAM'],
        description: 'Delivery channel.',
      },
    },
    required: ['handle', 'offsetMinutes'],
  },
  run: (input, context, host) =>
    Promise.resolve(host.handleSetReminder(input, context)),
});
