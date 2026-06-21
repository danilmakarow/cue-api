import { ZodType } from 'zod';

import { AiConnector } from '@/modules/ai/ai-connector.abstract';
import {
  AiCapabilities,
  AiModelRole,
  AiProvider,
  AiStopReason,
  CompletionRequest,
  CompletionResult,
  StreamTextHandler,
  ToolCall,
} from '@/modules/ai/ai.types';

/**
 * Builds a {@link CompletionResult} with zeroed usage, overlaid with the given
 * fields — mirrors the `completion()` helper in assistant.service.spec.ts so a
 * test states only what it cares about.
 */
export const completion = (
  over: Partial<CompletionResult>,
): CompletionResult => ({
  stopReason: AiStopReason.END_TURN,
  usage: {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  },
  ...over,
});

/**
 * Builds a {@link ToolCall} with a generated id unless one is supplied — mirrors
 * the `toolCall()` helper in assistant.service.spec.ts.
 */
export const toolCall = (
  name: string,
  input: Record<string, unknown> = {},
): ToolCall => ({
  id: `call-${name}-${Math.random().toString(36).slice(2, 8)}`,
  name,
  input,
});

/**
 * A deterministic {@link AiConnector} for e2e: `complete` returns the next
 * pre-scripted {@link CompletionResult} from a per-turn queue, so a test drives
 * the EXACT model behaviour (tool_use → end_turn, narration re-drive, etc.)
 * through the real orchestrator and the real Postgres/Redis pipeline — without
 * any network call. Overriding both `ACTIVE_AI_CONNECTOR` and the concrete
 * `AnthropicAiConnector` provider with this instance routes every model caller
 * (orchestrator + background jobs) here.
 *
 * `completeStructured` returns a canned, schema-valid object so the post-turn
 * summarizer / memory-extractor background jobs (which run after the reply) make
 * no real LLM call and never interfere with assertions.
 */
export class ScriptedAiConnector extends AiConnector {
  readonly provider = AiProvider.ANTHROPIC;

  readonly capabilities: AiCapabilities = {
    promptCaching: true,
    contextEditing: true,
    structuredOutput: true,
  };

  /** Remaining scripted results, consumed FIFO by `complete`. */
  private queue: CompletionResult[] = [];

  /** Every request `complete` received, in order, for optional assertions. */
  private readonly requests: CompletionRequest[] = [];

  /**
   * Queues the scripted results for the NEXT turn (call once per scenario before
   * POSTing the webhook). Replaces any leftover script so turns never bleed.
   */
  script(results: CompletionResult[]): void {
    this.queue = [...results];
    this.requests.length = 0;
  }

  /** The requests captured so far — lets a test assert on `toolChoice`, etc. */
  get capturedRequests(): readonly CompletionRequest[] {
    return this.requests;
  }

  /** Clears the script and captured requests between tests. */
  reset(): void {
    this.queue = [];
    this.requests.length = 0;
  }

  /**
   * Returns the next scripted result, recording the request. Throws when the
   * script is exhausted so a mis-scripted scenario fails loudly (as a turn
   * error) rather than hanging the orchestrator's loop.
   *
   * A BACKGROUND-role `complete` is the Story-13 per-round recap (it shares this
   * one connector in e2e, where everything routes here). It must NOT consume the
   * MAIN loop's scripted queue, so it returns a canned tiny recap — mirroring how
   * `completeStructured` is a separate canned path for the summarizer / memory
   * jobs. Only MAIN round-trips draw from the script.
   */
  async complete(request: CompletionRequest): Promise<CompletionResult> {
    this.requests.push(request);

    if (request.modelRole === AiModelRole.BACKGROUND) {
      return {
        stopReason: AiStopReason.END_TURN,
        text: 'Working on it',
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      };
    }

    const next = this.queue.shift();

    if (!next) {
      throw new Error(
        'ScriptedAiConnector: completion script exhausted — the scenario asked for ' +
          'more model round-trips than were scripted.',
      );
    }

    return next;
  }

  /**
   * Streaming variant used on the loop's final/answer round (Story 13). Consumes
   * the SAME scripted queue as {@link complete}, emits the result's text to
   * `onText` as a single delta (so an e2e assertion on streamed traffic sees it),
   * and returns the identical result — preserving the never-throw contract by
   * delegating the exhausted-script throw to `complete`'s deterministic failure.
   */
  async completeStream(
    request: CompletionRequest,
    onText: StreamTextHandler,
  ): Promise<CompletionResult> {
    const result = await this.complete(request);

    if (result.text && result.text.length > 0) {
      onText(result.text, result.text);
    }

    return result;
  }

  /**
   * Returns a canned, schema-valid object for the background summarizer / memory
   * extractor. Tries the smallest valid shapes for the two known background
   * schemas (`{ summary }` and `{ facts: [] }`); falls back to an empty object
   * parse so an unknown structured call still degrades to a no-op rather than a
   * throw.
   */
  async completeStructured<TResult>(
    _request: CompletionRequest,
    schema: ZodType<TResult>,
  ): Promise<TResult> {
    const summaryCandidate = schema.safeParse({ summary: '' });

    if (summaryCandidate.success) {
      return summaryCandidate.data;
    }

    const factsCandidate = schema.safeParse({ facts: [] });

    if (factsCandidate.success) {
      return factsCandidate.data;
    }

    return schema.parse({});
  }
}
