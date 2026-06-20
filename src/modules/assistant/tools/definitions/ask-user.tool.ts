import {
  MAX_ASK_USER_OPTIONS,
  ToolName,
  askUserInputSchema,
} from '../tool-schemas';
import { buildTool } from '../tool.contract';

/** Model-facing description for `ask_user` (ADR 0010). */
const ASK_USER_PROMPT =
  'Ask the user ONE concise clarifying question and pause — use this when you genuinely need a missing detail (a time, a choice, a confirmation) before you can act, instead of guessing. Optionally offer up to 4 tappable quick-reply options ({ id, label }) when the answer is one of a few clear choices; omit them for an open free-text question. The turn SUSPENDS here: your question is sent to the user, and the same task automatically resumes with their answer fed back to you (you may then ask again or proceed). Ask at most one question at a time, and only when the answer would actually change what you do.';

/**
 * `ask_user` — suspend-and-resume clarifying question (ADR 0010). Its `run()`
 * touches NO database and never calls a feature service: it returns a SENTINEL
 * (`askUser` on the outcome) that the orchestrator recognizes to stop the loop
 * and suspend the turn (persist a `pending_question` row + Redis mirror, send the
 * question, end the turn). The user's later answer is fed back as this call's
 * synthetic `tool_result` and the loop re-enters. Neither a write nor a
 * schedule-fetch (fail-closed defaults). Appended LAST in the registry's stable
 * order so the derived schema array stays byte-order-stable for the ADR-0004
 * cache prefix.
 */
export const askUserTool = buildTool({
  name: ToolName.ASK_USER,
  prompt: () => ASK_USER_PROMPT,
  inputSchema: askUserInputSchema,
  jsonSchema: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description:
          'The single, concise clarifying question to ask the user. The turn suspends here and resumes when the user answers.',
      },
      options: {
        type: 'array',
        maxItems: MAX_ASK_USER_OPTIONS,
        description: `Optional tappable quick-reply options (1-${MAX_ASK_USER_OPTIONS}). Offer them when the answer is one of a few clear choices; omit for an open free-text question.`,
        items: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              description:
                'Stable short option key echoed back when the user taps it (e.g. "fri", "1h"). Keep it terse and unique within the question.',
            },
            label: {
              type: 'string',
              description:
                'Human-facing button text shown to the user (e.g. "Friday").',
            },
          },
          required: ['id', 'label'],
        },
      },
    },
    required: ['question'],
  },
  run: (input, context, host) =>
    Promise.resolve(host.handleAskUser(input, context)),
});
