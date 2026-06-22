import Anthropic from '@anthropic-ai/sdk';
import { Injectable, Logger } from '@nestjs/common';
import { ZodType, z } from 'zod';

import { AiConnector } from '../ai-connector.abstract';
import { AiConfig } from '../ai.config';
import {
  AiCapabilities,
  AiModelRole,
  AiProvider,
  AiStopReason,
  AiToolChoice,
  AiUsage,
  CompletionRequest,
  CompletionResult,
  PromptBlock,
  PromptRole,
  StreamTextHandler,
  ToolCall,
  ToolResultBlock,
  ToolRound,
  ToolSchema,
} from '../ai.types';

/**
 * Anthropic beta header that enables native context editing — tool-result
 * hygiene for tool-heavy turns (spec "three memory mechanisms"). Value verified
 * against the installed SDK's `AnthropicBeta` union, not just the ADR.
 */
const CONTEXT_MANAGEMENT_BETA = 'context-management-2025-06-27';

/**
 * The SDK's literal for the clear-tool-uses context edit. The bare
 * `clear_tool_uses` from the ADR/spec is NOT what `@anthropic-ai/sdk` accepts —
 * `BetaContextManagementConfig.edits[].type` is this dated literal.
 */
const CLEAR_TOOL_USES_EDIT_TYPE = 'clear_tool_uses_20250919';

/** Ephemeral cache-control marker applied at flagged breakpoints (ADR 0004). */
const EPHEMERAL_CACHE: Anthropic.Messages.CacheControlEphemeral = {
  type: 'ephemeral',
};

/**
 * How many times `completeStructured` re-asks the model after a schema/parse
 * failure before giving up (Task 2 structured-output risk note).
 */
const STRUCTURED_RETRY_ATTEMPTS = 1;

/** Tool name used to coerce a structured JSON result out of the model. */
const STRUCTURED_OUTPUT_TOOL_NAME = 'respond_with_structured_output';

/** HTTP statuses the SDK treats as retryable (network errors have no status). */
const RETRYABLE_STATUSES = new Set([408, 409, 429]);
/** Floor at/above which any HTTP status is a retryable server error. */
const SERVER_ERROR_STATUS = 500;

/** Anthropic's "service overloaded" HTTP status. */
const OVERLOADED_STATUS = 529;

/**
 * Body marker for an overload, surfaced even when the SDK drops the 529 status
 * mid-stream. Matched as a substring so it survives whatever wrapper text the
 * SDK puts around the JSON error body.
 */
const OVERLOADED_BODY_MARKER = '"type":"overloaded_error"';

/**
 * True when a failed Anthropic call is an overload (529). Returns true when the
 * HTTP status is exactly 529 OR — because the SDK sometimes drops the status
 * mid-stream — when the error message/body carries the `"type":"overloaded_error"`
 * substring. Exported so both the main-model fallback decision and
 * {@link AnthropicAiConnector.describeAnthropicError} share one definition of
 * "this is an overload". Reads only the status and the error message — never
 * prompt, tool, or response content.
 */
export const is529 = (error: unknown): boolean => {
  if (
    error instanceof Anthropic.APIError &&
    error.status === OVERLOADED_STATUS
  ) {
    return true;
  }

  const message = error instanceof Error ? error.message : String(error);

  return message.includes(OVERLOADED_BODY_MARKER);
};

/**
 * Provider-side detail extracted from a failed Anthropic call, for logging only.
 * Every field is metadata — never prompt, tool, or response content. `status`
 * and `errorType` are absent on transport (network) failures that never reached
 * the API; `retryable` mirrors the SDK's own retry classification.
 */
interface AnthropicErrorDetail {
  status?: number;
  errorType?: string;
  requestId?: string;
  retryable: boolean;
  overloaded: boolean;
  message: string;
}

/**
 * Anthropic implementation of {@link AiConnector} over `@anthropic-ai/sdk`.
 *
 * Maps the normalized {@link CompletionRequest} onto the Messages API
 * (`system` + `messages` + `tools`), applies `cache_control: ephemeral` at the
 * caller-marked breakpoints, surfaces `tool_use` as normalized tool calls, and
 * returns token usage including cache reads/writes. Performs exactly one model
 * round-trip per call — the tool loop lives in the orchestrator (Task 3).
 *
 * Multi-round tool use: completed rounds ride back in via `request.toolRounds`
 * (normalized {@link ToolCall} / {@link ToolResultBlock}), and the connector
 * renders each as an assistant `tool_use` turn followed by a user `tool_result`
 * turn. No vendor turn-structure crosses the boundary, and the connector holds
 * no cross-call state (it is a shared singleton).
 *
 * Retry policy lives at the transport layer: the SDK client is constructed with
 * `maxRetries` from config, so retryable failures (connection errors, 408/409/
 * 429/>=500) get bounded exponential backoff inside the SDK. Terminal errors
 * (after retries are exhausted) propagate raw — the orchestrator (Task 3) maps
 * them to the spec's graceful "having trouble right now" reply. No hand-rolled
 * retry loop and no custom error type here.
 */
@Injectable()
export class AnthropicAiConnector extends AiConnector {
  private readonly logger = new Logger(AnthropicAiConnector.name);

  private readonly client: Anthropic;

  readonly provider = AiProvider.ANTHROPIC;

  readonly capabilities: AiCapabilities = {
    promptCaching: true,
    contextEditing: true,
    structuredOutput: true,
  };

  constructor(private readonly config: AiConfig) {
    super();
    this.client = new Anthropic({
      apiKey: this.config.getAnthropicApiKey(),
      maxRetries: this.config.getMaxRetries(),
    });
  }

  /**
   * Maps normalized prompt blocks to Anthropic `MessageParam`s, then appends any
   * completed tool-loop rounds as the volatile tail. Each round renders as the
   * assistant turn that made the tool calls followed by the user turn carrying
   * their results — the structure the Messages API requires (a `tool_result`
   * must follow an assistant turn containing the matching `tool_use`). Caching
   * markers apply only to the prompt blocks; the tail is always volatile.
   */
  private buildMessages(
    blocks: PromptBlock[],
    toolRounds: ToolRound[] | undefined,
    cachingEnabled: boolean,
  ): Anthropic.Messages.MessageParam[] {
    const messages: Anthropic.Messages.MessageParam[] = blocks.map((block) =>
      this.toMessageParam(block, cachingEnabled),
    );

    for (const round of toolRounds ?? []) {
      messages.push(this.toToolUseMessage(round));
      messages.push(this.toToolResultMessage(round.toolResults));
    }

    return messages;
  }

  /**
   * Converts a single prompt block into a `MessageParam`. A `cacheBoundary`
   * block becomes a one-element content array carrying `cache_control` so the
   * breakpoint lands on that block; otherwise the cheaper string form is used.
   */
  private toMessageParam(
    block: PromptBlock,
    cachingEnabled: boolean,
  ): Anthropic.Messages.MessageParam {
    const role = block.role === PromptRole.ASSISTANT ? 'assistant' : 'user';

    if (!cachingEnabled || !block.cacheBoundary) {
      return { role, content: block.content };
    }

    const textBlock: Anthropic.Messages.TextBlockParam = {
      type: 'text',
      text: block.content,
      cache_control: EPHEMERAL_CACHE,
    };

    return { role, content: [textBlock] };
  }

  /**
   * Renders the assistant turn of a tool round: optional leading text followed
   * by one `tool_use` block per call. `tool_use.id` is preserved verbatim so the
   * following turn's `tool_result.tool_use_id` references resolve.
   */
  private toToolUseMessage(round: ToolRound): Anthropic.Messages.MessageParam {
    const content: Anthropic.Messages.ContentBlockParam[] = [];

    if (round.assistantText && round.assistantText.length > 0) {
      content.push({ type: 'text', text: round.assistantText });
    }

    for (const call of round.toolCalls) {
      content.push({
        type: 'tool_use',
        id: call.id,
        name: call.name,
        input: call.input,
      });
    }

    return { role: 'assistant', content };
  }

  /**
   * Bundles a round's tool results into a single user message of `tool_result`
   * content blocks, as the Messages API expects. `tool_use_id` pairs each result
   * to its originating `tool_use` by id; `isError` maps to the SDK's `is_error`.
   */
  private toToolResultMessage(
    toolResults: ToolResultBlock[],
  ): Anthropic.Messages.MessageParam {
    const content: Anthropic.Messages.ToolResultBlockParam[] = toolResults.map(
      (result) => ({
        type: 'tool_result',
        tool_use_id: result.toolCallId,
        content: result.content,
        is_error: result.isError ?? false,
      }),
    );

    return { role: 'user', content };
  }

  /**
   * Maps the optional ordered system blocks into Anthropic's `system` param as
   * `TextBlockParam`s, applying `cache_control` at any flagged breakpoint.
   * Returns undefined when there are no system blocks.
   */
  private buildSystem(
    blocks: PromptBlock[] | undefined,
    cachingEnabled: boolean,
  ): Anthropic.Messages.TextBlockParam[] | undefined {
    if (!blocks || blocks.length === 0) {
      return undefined;
    }

    return blocks.map((block) => {
      const textBlock: Anthropic.Messages.TextBlockParam = {
        type: 'text',
        text: block.content,
      };

      if (cachingEnabled && block.cacheBoundary) {
        textBlock.cache_control = EPHEMERAL_CACHE;
      }

      return textBlock;
    });
  }

  /**
   * Maps normalized tool schemas to Anthropic `Tool`s, applying `cache_control`
   * at the flagged breakpoint (ADR 0004 #1, after the tool definitions).
   */
  private buildTools(
    tools: ToolSchema[] | undefined,
    cachingEnabled: boolean,
  ): Anthropic.Messages.Tool[] | undefined {
    if (!tools || tools.length === 0) {
      return undefined;
    }

    return tools.map((tool) => {
      const mapped: Anthropic.Messages.Tool = {
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema as Anthropic.Messages.Tool.InputSchema,
      };

      if (cachingEnabled && tool.cacheBoundary) {
        mapped.cache_control = EPHEMERAL_CACHE;
      }

      return mapped;
    });
  }

  /**
   * Translates a vendor-neutral {@link AiToolChoice} into Anthropic's
   * `tool_choice` shape: `'any' → {type:'any'}`, `{name} → {type:'tool',name}`,
   * `'auto' → {type:'auto'}`. Returns undefined when the directive is absent —
   * the caller then omits `tool_choice` entirely (implicit `auto`, unchanged
   * behaviour). DEGRADES to undefined (never throws) when there are no tools to
   * choose from: a forced choice with an empty/absent tool set is meaningless,
   * so we drop it rather than send the provider an unsatisfiable request.
   */
  private translateToolChoice(
    toolChoice: AiToolChoice | undefined,
    hasTools: boolean,
  ): Anthropic.Messages.ToolChoice | undefined {
    if (!toolChoice || !hasTools) {
      return undefined;
    }

    if (toolChoice === 'auto') {
      return { type: 'auto' };
    }

    if (toolChoice === 'any') {
      return { type: 'any' };
    }

    return { type: 'tool', name: toolChoice.name };
  }

  /**
   * Normalizes an Anthropic stop reason into the provider-neutral enum. Unknown
   * or transient reasons (e.g. `pause_turn`) collapse to `OTHER`.
   */
  private mapStopReason(
    stopReason: Anthropic.Messages.StopReason | null,
  ): AiStopReason {
    switch (stopReason) {
      case 'end_turn':
        return AiStopReason.END_TURN;
      case 'tool_use':
        return AiStopReason.TOOL_USE;
      case 'max_tokens':
        return AiStopReason.MAX_TOKENS;
      case 'stop_sequence':
        return AiStopReason.STOP_SEQUENCE;
      case 'refusal':
        return AiStopReason.REFUSAL;
      default:
        return AiStopReason.OTHER;
    }
  }

  /**
   * Normalizes Anthropic token usage, coalescing nullable cache counters to 0.
   */
  private mapUsage(usage: Anthropic.Messages.Usage): AiUsage {
    return {
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheReadTokens: usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
    };
  }

  /**
   * Extracts concatenated text from the response content blocks, or undefined
   * when the model returned no text (e.g. a pure tool-use turn).
   */
  private extractText(
    content: Anthropic.Messages.ContentBlock[],
  ): string | undefined {
    const text = content
      .filter(
        (block): block is Anthropic.Messages.TextBlock => block.type === 'text',
      )
      .map((block) => block.text)
      .join('');

    return text.length > 0 ? text : undefined;
  }

  /**
   * Extracts normalized tool calls from the response content blocks, or
   * undefined when the model requested none.
   */
  private extractToolCalls(
    content: Anthropic.Messages.ContentBlock[],
  ): ToolCall[] | undefined {
    const toolCalls = content
      .filter(
        (block): block is Anthropic.Messages.ToolUseBlock =>
          block.type === 'tool_use',
      )
      .map((block) => ({
        id: block.id,
        name: block.name,
        input: (block.input ?? {}) as Record<string, unknown>,
      }));

    return toolCalls.length > 0 ? toolCalls : undefined;
  }

  /**
   * Normalizes a raw Anthropic message into a {@link CompletionResult}.
   */
  private toCompletionResult(
    message: Anthropic.Messages.Message,
  ): CompletionResult {
    return {
      stopReason: this.mapStopReason(message.stop_reason),
      text: this.extractText(message.content),
      toolCalls: this.extractToolCalls(message.content),
      usage: this.mapUsage(message.usage),
    };
  }

  /**
   * Issues one round-trip to the Messages API. Routes through the beta endpoint
   * with the context-management beta header + `clear_tool_uses` config only when
   * context editing is both requested and supported; otherwise uses the stable
   * endpoint. The two response shapes share the fields the normalizer reads.
   */
  private async createMessage(
    params: Anthropic.Messages.MessageCreateParamsNonStreaming,
    contextEditingEnabled: boolean,
  ): Promise<Anthropic.Messages.Message> {
    if (!contextEditingEnabled) {
      return this.client.messages.create(params);
    }

    const betaParams: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming =
      {
        ...(params as Anthropic.Beta.Messages.MessageCreateParamsNonStreaming),
        betas: [CONTEXT_MANAGEMENT_BETA],
        context_management: {
          edits: [{ type: CLEAR_TOOL_USES_EDIT_TYPE }],
        },
      };

    const message = await this.client.beta.messages.create(betaParams);

    return message as unknown as Anthropic.Messages.Message;
  }

  /**
   * Assembles the Messages API request body from a normalized request. Caching
   * and context editing are gated on both the request flag and the connector's
   * declared capability, so an unsupported feature degrades to a no-op.
   */
  private buildCreateParams(
    request: CompletionRequest,
    overrides?: {
      tools?: Anthropic.Messages.Tool[];
      toolChoice?: Anthropic.Messages.ToolChoice;
    },
  ): Anthropic.Messages.MessageCreateParamsNonStreaming {
    const cachingEnabled =
      this.capabilities.promptCaching &&
      request.features?.promptCaching === true;

    const params: Anthropic.Messages.MessageCreateParamsNonStreaming = {
      model: this.config.getModelId(request.modelRole),
      max_tokens: request.maxTokens ?? this.config.getMaxOutputTokens(),
      messages: this.buildMessages(
        request.messages,
        request.toolRounds,
        cachingEnabled,
      ),
    };

    const system = this.buildSystem(request.system, cachingEnabled);

    if (system) {
      params.system = system;
    }

    const tools =
      overrides?.tools ?? this.buildTools(request.tools, cachingEnabled);

    if (tools) {
      params.tools = tools;
    }

    // An explicit override (the `completeStructured` forced-tool path) wins;
    // otherwise translate the request's vendor-neutral directive, degrading to
    // an omitted choice when there are no tools to force.
    const toolChoice =
      overrides?.toolChoice ??
      this.translateToolChoice(request.toolChoice, tools !== undefined);

    if (toolChoice) {
      params.tool_choice = toolChoice;
    }

    return params;
  }

  /**
   * Extracts log-safe provider detail from a failed call. For an
   * `Anthropic.APIError` it reads the HTTP `status`, the body `error.type`, and
   * the `request-id` (all exposed directly on the SDK error), and classifies
   * `retryable` the way the SDK does: no status means a network failure (worth a
   * retry), otherwise 408/409/429 or any >=500. Non-API errors fall back to the
   * message with `retryable: false`. Never touches request or response content.
   */
  private describeAnthropicError(error: unknown): AnthropicErrorDetail {
    if (!(error instanceof Anthropic.APIError)) {
      return {
        retryable: false,
        overloaded: is529(error),
        message: error instanceof Error ? error.message : String(error),
      };
    }

    const status = typeof error.status === 'number' ? error.status : undefined;
    const retryable =
      status === undefined ||
      RETRYABLE_STATUSES.has(status) ||
      status >= SERVER_ERROR_STATUS;

    return {
      status,
      errorType: error.type ?? undefined,
      requestId: error.requestID ?? undefined,
      retryable,
      overloaded: is529(error),
      message: error.message,
    };
  }

  /**
   * Emits a single greppable error log for a failed model round-trip, pairing
   * the operation and request-size metadata (counts, not content) with the
   * provider detail from {@link describeAnthropicError}. Logs only metadata — no
   * prompt, system, tool, or response text, and no API key. The error stack
   * rides in the second `logger.error` argument when present.
   */
  private logCompletionFailure(
    operation: string,
    request: CompletionRequest,
    error: unknown,
  ): void {
    const detail = this.describeAnthropicError(error);
    const modelRole = request.modelRole ?? AiModelRole.BACKGROUND;
    const message =
      `Anthropic request failed: operation=${operation} ` +
      `traceId=${request.traceId ?? 'none'} ` +
      `model=${this.config.getModelId(modelRole)} modelRole=${modelRole} ` +
      `promptCaching=${request.features?.promptCaching === true} ` +
      `contextEditing=${request.features?.contextEditing === true} ` +
      `messages=${request.messages.length} tools=${request.tools?.length ?? 0} ` +
      `toolRounds=${request.toolRounds?.length ?? 0} ` +
      `maxTokens=${request.maxTokens ?? this.config.getMaxOutputTokens()} ` +
      `status=${detail.status ?? 'none'} errorType=${detail.errorType ?? 'none'} ` +
      `requestId=${detail.requestId ?? 'none'} retryable=${detail.retryable} ` +
      `overloaded=${detail.overloaded} ` +
      `message=${detail.message}`;
    const stack = error instanceof Error ? error.stack : undefined;

    this.logger.error(message, stack);
  }

  /**
   * Emits a single metadata-only debug log of the prompt-cache token counters
   * (`cache_read_input_tokens` / `cache_creation_input_tokens`, surfaced as the
   * normalized cacheRead/cacheWrite usage) for a successful round-trip, so cache
   * hit/miss behaviour is observable without reading any prompt or response
   * content. Mirrors the metadata-only style of {@link logCompletionFailure}.
   */
  private logCacheUsage(
    operation: string,
    request: CompletionRequest,
    usage: AiUsage,
  ): void {
    const modelRole = request.modelRole ?? AiModelRole.BACKGROUND;

    this.logger.debug(
      `Anthropic cache usage: operation=${operation} ` +
        `traceId=${request.traceId ?? 'none'} ` +
        `modelRole=${modelRole} ` +
        `cacheReadTokens=${usage.cacheReadTokens} ` +
        `cacheWriteTokens=${usage.cacheWriteTokens} ` +
        `inputTokens=${usage.inputTokens} outputTokens=${usage.outputTokens}`,
    );
  }

  /**
   * Emits a single metadata-only info log recording a MAIN → fallback model swap
   * after a post-retry 529 overload (ADR 0018: BACKGROUND is reused as the
   * fallback — no new env var). Logs only the trace id and the two model ids —
   * never prompt, tool, or response content.
   */
  private logFallbackSwap(
    request: CompletionRequest,
    fallbackModel: string,
  ): void {
    this.logger.warn(
      `Anthropic 529 overload on MAIN — retrying once on fallback model: ` +
        `operation=complete traceId=${request.traceId ?? 'none'} ` +
        `fromModel=${this.config.getModelId(AiModelRole.MAIN)} ` +
        `fromModelRole=${AiModelRole.MAIN} ` +
        `toModel=${fallbackModel} toModelRole=${AiModelRole.BACKGROUND}`,
    );
  }

  /**
   * Re-issues the SAME request once on the fallback model after a post-retry 529
   * on the MAIN model. Rebuilds the params with the BACKGROUND model id (ADR
   * 0018 reuses BACKGROUND as the fallback — no dedicated env var) and re-invokes
   * the model. Any failure here — a second 529 or anything else — is logged and
   * rethrown raw so the orchestrator maps it to the graceful terminal reply.
   */
  private async completeOnFallbackModel(
    request: CompletionRequest,
    contextEditingEnabled: boolean,
  ): Promise<CompletionResult> {
    const fallbackModel = this.config.getModelId(AiModelRole.BACKGROUND);

    this.logFallbackSwap(request, fallbackModel);

    const fallbackParams = this.buildCreateParams(request);

    fallbackParams.model = fallbackModel;

    try {
      const message = await this.createMessage(
        fallbackParams,
        contextEditingEnabled,
      );
      const result = this.toCompletionResult(message);

      this.logCacheUsage('complete:fallback', request, result.usage);

      return result;
    } catch (fallbackError) {
      this.logCompletionFailure('complete:fallback', request, fallbackError);
      throw fallbackError;
    }
  }

  /**
   * Performs one model round-trip and returns the normalized result. See the
   * class doc for the single-round-trip boundary.
   *
   * Overload fallback (Story 3b / ADR 0018): when the request targets the MAIN
   * model and the call fails with a 529 overload AFTER the SDK's own retries are
   * exhausted, the connector retries the SAME request exactly once on the
   * fallback model (the BACKGROUND model id — reused, no new env var). Only MAIN
   * is eligible; BACKGROUND and structured calls never fall back. A non-529
   * failure is never retried with the fallback. If the fallback also fails (529
   * or otherwise), the error propagates raw so the orchestrator can map it to the
   * graceful reply.
   */
  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const contextEditingEnabled =
      this.capabilities.contextEditing &&
      request.features?.contextEditing === true;

    const params = this.buildCreateParams(request);

    try {
      const message = await this.createMessage(params, contextEditingEnabled);
      const result = this.toCompletionResult(message);

      this.logCacheUsage('complete', request, result.usage);

      return result;
    } catch (error) {
      this.logCompletionFailure('complete', request, error);

      if (request.modelRole === AiModelRole.MAIN && is529(error)) {
        return this.completeOnFallbackModel(request, contextEditingEnabled);
      }

      throw error;
    }
  }

  /**
   * Opens the streaming round-trip for {@link completeStream}, routing through the
   * beta endpoint with the context-management config when context editing is both
   * requested and supported (mirroring {@link createMessage}), else the stable
   * endpoint. Both return an SDK `MessageStream` exposing the same `on('text')` /
   * `finalMessage()` surface the caller drives. NOTE: only the request building is
   * shared with {@link complete}; the 529→fallback retry is handled by
   * {@link completeStream} around this call, not here.
   */
  private openMessageStream(
    params: Anthropic.Messages.MessageStreamParams,
    contextEditingEnabled: boolean,
  ): ReturnType<Anthropic.Messages['stream']> {
    if (!contextEditingEnabled) {
      return this.client.messages.stream(params);
    }

    // The beta stream takes the same body shape as the beta create (minus the
    // SDK-managed `stream` flag), so the non-streaming beta param type is reused —
    // mirroring how `createMessage` builds its beta params.
    const betaParams: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming =
      {
        ...(params as Anthropic.Beta.Messages.MessageCreateParamsNonStreaming),
        betas: [CONTEXT_MANAGEMENT_BETA],
        context_management: {
          edits: [{ type: CLEAR_TOOL_USES_EDIT_TYPE }],
        },
      };

    return this.client.beta.messages.stream(
      betaParams,
    ) as unknown as ReturnType<Anthropic.Messages['stream']>;
  }

  /**
   * Consumes one streaming round-trip end to end: subscribes `onText` to the
   * SDK's `text` event (each delta + the running snapshot) and resolves with the
   * normalized result from {@link finalMessage}. The `onText` handler is wrapped
   * so a throwing caller callback never tears down the stream — the contract is
   * that streaming degrades, never throws (the delta is simply not rendered).
   * Rejects only if the underlying stream errors/aborts — {@link completeStream}
   * owns that recovery.
   */
  private async consumeStream(
    stream: ReturnType<Anthropic.Messages['stream']>,
    onText: StreamTextHandler,
  ): Promise<CompletionResult> {
    stream.on('text', (delta: string, snapshot: string) => {
      try {
        onText(delta, snapshot);
      } catch (handlerError) {
        const message =
          handlerError instanceof Error
            ? handlerError.message
            : String(handlerError);

        this.logger.debug(
          `completeStream onText handler threw (delta dropped): ${message}`,
        );
      }
    });

    const message = await stream.finalMessage();

    return this.toCompletionResult(message as Anthropic.Messages.Message);
  }

  /**
   * Builds a best-effort {@link CompletionResult} from whatever text was streamed
   * before a fault, used as the LAST-resort return when both the stream AND the
   * non-streamed fallback fail. Carries the partial text (if any), an `OTHER` stop
   * reason (the turn did not end cleanly), no tool calls, and zero usage (the
   * counters never arrived). This is the floor that makes
   * {@link completeStream}'s never-throw contract total: even a double failure
   * returns a valid result rather than propagating.
   */
  private partialStreamResult(streamedText: string): CompletionResult {
    return {
      stopReason: AiStopReason.OTHER,
      text: streamedText.length > 0 ? streamedText : undefined,
      toolCalls: undefined,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    };
  }

  /**
   * Streaming variant of {@link complete} (Story 13 / ADR 0041). Builds the SAME
   * params as {@link complete} (model, cached system, tools, tool rounds,
   * max_tokens) but streams via the SDK's `messages.stream()` (or the beta stream
   * for a context-edited turn), forwarding each text delta to `onText`, and
   * returns the SAME normalized {@link CompletionResult} once the stream settles.
   *
   * **Never throws (the loop is `attempts:1`).** A captured snapshot of the
   * streamed text is kept so any fault can reconcile to it. On a stream
   * error/abort/empty-stream — or a MAIN-model 529 — it falls back to a
   * non-streamed {@link complete} (which itself owns the 529→fallback-model
   * retry); if THAT also fails, it returns {@link partialStreamResult} built from
   * whatever streamed. Either way the caller gets a valid result, never an
   * exception.
   */
  async completeStream(
    request: CompletionRequest,
    onText: StreamTextHandler,
  ): Promise<CompletionResult> {
    const contextEditingEnabled =
      this.capabilities.contextEditing &&
      request.features?.contextEditing === true;

    // `messages.stream()` takes the same body as `create()` minus the `stream`
    // flag (the SDK sets `stream: true` internally), so the non-streaming params
    // builder is reused verbatim — keeping request building identical to
    // `complete` (model, cached system, tools, tool rounds, max_tokens).
    const params: Anthropic.Messages.MessageStreamParams =
      this.buildCreateParams(request);

    // Track the latest full-text snapshot so a mid-stream fault can reconcile to
    // it (and so the last-resort partial result carries the user-visible text).
    let streamedText = '';
    const captureText: StreamTextHandler = (delta, snapshot) => {
      streamedText = snapshot;
      onText(delta, snapshot);
    };

    try {
      const stream = this.openMessageStream(params, contextEditingEnabled);
      const result = await this.consumeStream(stream, captureText);

      this.logCacheUsage('completeStream', request, result.usage);

      return result;
    } catch (error) {
      this.logCompletionFailure('completeStream', request, error);

      return this.recoverFromStreamFailure(request, streamedText);
    }
  }

  /**
   * Recovers a {@link completeStream} fault WITHOUT throwing: re-issues the same
   * request as a non-streamed {@link complete} (which owns the MAIN-model 529→
   * fallback retry and the SDK's transport retries), and on a second failure
   * returns a {@link partialStreamResult} from the text that did stream. This is
   * the heart of the never-throw contract — the loop only ever sees a result.
   */
  private async recoverFromStreamFailure(
    request: CompletionRequest,
    streamedText: string,
  ): Promise<CompletionResult> {
    try {
      this.logger.warn(
        `completeStream falling back to non-streamed complete: ` +
          `traceId=${request.traceId ?? 'none'} ` +
          `streamedChars=${streamedText.length}`,
      );

      return await this.complete(request);
    } catch (fallbackError) {
      this.logCompletionFailure(
        'completeStream:fallback',
        request,
        fallbackError,
      );

      // Both the stream and the non-streamed fallback failed: return whatever
      // streamed (or an empty partial) so the loop still answers. Never throws.
      return this.partialStreamResult(streamedText);
    }
  }

  /**
   * Forces a structured JSON result and validates it against `schema`. Exposes
   * the schema as a single tool the model must call (`tool_choice: tool`),
   * parses the tool input, and validates. On a schema/parse failure it re-asks
   * the model up to {@link STRUCTURED_RETRY_ATTEMPTS} times before throwing.
   * Defaults to the BACKGROUND model role when the request omits one.
   */
  async completeStructured<TResult>(
    request: CompletionRequest,
    schema: ZodType<TResult>,
  ): Promise<TResult> {
    const jsonSchema = z.toJSONSchema(schema) as Record<string, unknown>;

    const tool: Anthropic.Messages.Tool = {
      name: STRUCTURED_OUTPUT_TOOL_NAME,
      description:
        'Return the final answer as a single structured object matching the schema.',
      input_schema: {
        type: 'object',
        ...jsonSchema,
      } as Anthropic.Messages.Tool.InputSchema,
    };

    const structuredRequest: CompletionRequest = {
      ...request,
      modelRole: request.modelRole ?? AiModelRole.BACKGROUND,
    };

    const params = this.buildCreateParams(structuredRequest, {
      tools: [tool],
      toolChoice: { type: 'tool', name: STRUCTURED_OUTPUT_TOOL_NAME },
    });

    let lastError: unknown;

    for (let attempt = 0; attempt <= STRUCTURED_RETRY_ATTEMPTS; attempt += 1) {
      let message: Anthropic.Messages.Message;

      try {
        message = await this.client.messages.create(params);
      } catch (error) {
        this.logCompletionFailure(
          'completeStructured',
          structuredRequest,
          error,
        );
        throw error;
      }

      const toolCalls = this.extractToolCalls(message.content);
      const call = toolCalls?.[0];

      if (!call) {
        lastError = new Error(
          'Structured completion returned no tool call to parse',
        );
        this.logger.warn(
          `completeStructured: no tool call on attempt ${attempt + 1}`,
        );
        continue;
      }

      const parsed = schema.safeParse(call.input);

      if (parsed.success) {
        return parsed.data;
      }

      lastError = parsed.error;
      this.logger.warn(
        `completeStructured: schema validation failed on attempt ${attempt + 1}: ${parsed.error.message}`,
      );
    }

    throw lastError instanceof Error
      ? lastError
      : new Error('Structured completion failed to produce a valid result');
  }
}
