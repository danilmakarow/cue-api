import { ZodType } from 'zod';

import {
  AiCapabilities,
  AiProvider,
  CompletionRequest,
  CompletionResult,
  StreamTextHandler,
} from './ai.types';

/**
 * Provider-agnostic LLM connector contract (ADR 0007). An implementation maps
 * the normalized {@link CompletionRequest} onto a single vendor round-trip and
 * normalizes the response back into a {@link CompletionResult}.
 *
 * Boundary (ADR 0007 / Task 2): each call performs **exactly one** model
 * round-trip. The multi-step tool loop, tool dispatch, and the 5-fetch cap live
 * in the orchestrator (Task 3); this contract only surfaces `stopReason`,
 * `toolCalls`, and `usage` faithfully so the orchestrator can drive the loop.
 */
export abstract class AiConnector {
  /** The provider this connector talks to. */
  abstract readonly provider: AiProvider;

  /** Features this implementation supports; callers degrade gracefully. */
  abstract readonly capabilities: AiCapabilities;

  /**
   * Performs one model round-trip and returns the normalized result — final
   * text and/or tool calls, the stop reason, and token usage.
   */
  abstract complete(request: CompletionRequest): Promise<CompletionResult>;

  /**
   * Streaming variant of {@link complete} (Story 13 / ADR 0041). Builds the SAME
   * request as {@link complete} (model, cached system blocks, tools, tool rounds,
   * max_tokens, the 529→fallback posture) but streams the answer incrementally:
   * each text delta is delivered to `onText(delta, snapshot)` as it arrives, and
   * the SAME normalized {@link CompletionResult} `complete` returns
   * (`stopReason` / `toolCalls` / `text` / `usage`) is returned once the stream
   * settles — so the orchestrator loop is agnostic to whether a round streamed.
   *
   * **CONTRACT — MUST RETURN, NEVER THROW.** The orchestrator's webhook queue is
   * `attempts:1`; a throw out of the loop drops the turn with no retry. So on ANY
   * stream fault — a mid-stream error, an abort, an overload, an empty stream, or
   * a throwing `onText` — this method reconciles whatever text was streamed,
   * falls back to a non-streamed {@link complete} (or a best-effort partial
   * result built from the streamed text), and RETURNS a valid
   * {@link CompletionResult}. It never propagates an exception to the caller.
   * Implementations that genuinely cannot recover MUST still return a result
   * (e.g. an `OTHER` stop reason with the partial text), not throw.
   */
  abstract completeStream(
    request: CompletionRequest,
    onText: StreamTextHandler,
  ): Promise<CompletionResult>;

  /**
   * Background helper for structured JSON jobs (rolling summary, memory-fact
   * extraction, query-aware date parse). Forces a JSON result, validates it
   * against `schema`, and returns the typed object. Defaults to the BACKGROUND
   * model role when the request does not specify one.
   */
  abstract completeStructured<TResult>(
    request: CompletionRequest,
    schema: ZodType<TResult>,
  ): Promise<TResult>;
}
