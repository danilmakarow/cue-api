import { ZodType } from 'zod';

import {
  AiCapabilities,
  AiProvider,
  CompletionRequest,
  CompletionResult,
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
