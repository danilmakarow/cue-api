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
  AiUsage,
  CompletionRequest,
  CompletionResult,
  PromptBlock,
  PromptRole,
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

    if (overrides?.toolChoice) {
      params.tool_choice = overrides.toolChoice;
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
      `message=${detail.message}`;
    const stack = error instanceof Error ? error.stack : undefined;

    this.logger.error(message, stack);
  }

  /**
   * Performs one model round-trip and returns the normalized result. See the
   * class doc for the single-round-trip boundary. A terminal provider failure
   * (after the SDK's own retries) is logged with full provider detail, then
   * rethrown raw so the orchestrator can map it to the graceful reply.
   */
  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const contextEditingEnabled =
      this.capabilities.contextEditing &&
      request.features?.contextEditing === true;

    const params = this.buildCreateParams(request);

    try {
      const message = await this.createMessage(params, contextEditingEnabled);

      return this.toCompletionResult(message);
    } catch (error) {
      this.logCompletionFailure('complete', request, error);
      throw error;
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
