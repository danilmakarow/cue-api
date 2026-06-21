import Anthropic from '@anthropic-ai/sdk';
import { Logger } from '@nestjs/common';
import { z } from 'zod';

import { AnthropicAiConnector, is529 } from './anthropic-ai.connector';
import { AiConfig } from '../ai.config';
import {
  AiModelRole,
  AiProvider,
  AiStopReason,
  CompletionRequest,
  PromptRole,
} from '../ai.types';

/**
 * The Anthropic SDK constructor is mocked so that every `new Anthropic(...)`
 * yields a client whose `messages.create` and `beta.messages.create` are fresh
 * jest spies. We never hit the network. The spies are pulled off the instance
 * the connector actually constructs (see `beforeEach`) rather than a module
 * closure, so the wiring is robust to cross-file mock-registry sharing.
 */
jest.mock('@anthropic-ai/sdk', () => {
  // A real-enough `APIError` exposing the fields the connector reads (status,
  // body `error.type`, request id). The connector narrows on
  // `Anthropic.APIError`, which the real SDK exposes as a static on the default
  // export — so the mock attaches the SAME class there for `instanceof` to pass.
  class APIError extends Error {
    status?: number;

    type?: string;

    requestID?: string | null;

    constructor(
      status: number | undefined,
      type: string | undefined,
      requestID: string | null | undefined,
      message: string,
    ) {
      super(message);
      this.status = status;
      this.type = type;
      this.requestID = requestID;
    }
  }

  const ctor = jest.fn().mockImplementation(() => ({
    messages: { create: jest.fn(), stream: jest.fn() },
    beta: { messages: { create: jest.fn(), stream: jest.fn() } },
  }));

  (ctor as unknown as { APIError: typeof APIError }).APIError = APIError;

  return ctor;
});

const AnthropicMock = Anthropic as unknown as jest.Mock;

/**
 * The mocked `Anthropic.APIError` constructor, re-typed for ergonomic test
 * construction. It is the SAME class the connector's `instanceof Anthropic.APIError`
 * check sees (both resolve to the mocked module).
 */
type MockAnthropicApiErrorConstructor = new (
  status: number | undefined,
  type: string | undefined,
  requestID: string | null | undefined,
  message: string,
) => Error;
const MockAnthropicApiError = (Anthropic as unknown as { APIError: unknown })
  .APIError as MockAnthropicApiErrorConstructor;

/** The live `messages.create` spy for the most recently constructed client. */
let messagesCreate: jest.Mock;

/** The live `messages.stream` spy for the most recently constructed client. */
let messagesStream: jest.Mock;

/** The live `beta.messages.create` spy for the most recently constructed client. */
let betaMessagesCreate: jest.Mock;

/** The live `beta.messages.stream` spy for the most recently constructed client. */
let betaMessagesStream: jest.Mock;

/**
 * A minimal fake of the SDK `MessageStream` (Story 13). `on('text', …)` is invoked
 * synchronously with each scripted delta + the running snapshot; `finalMessage()`
 * resolves to the supplied message (or rejects, to drive the never-throw fallback
 * path). Only the surface the connector consumes is implemented.
 */
const fakeMessageStream = (options: {
  deltas?: string[];
  finalMessage?: Anthropic.Messages.Message;
  finalError?: Error;
}) => {
  const textListeners: Array<(delta: string, snapshot: string) => void> = [];

  return {
    on(event: string, listener: (delta: string, snapshot: string) => void) {
      if (event === 'text') {
        textListeners.push(listener);
      }

      return this;
    },
    async finalMessage(): Promise<Anthropic.Messages.Message> {
      let snapshot = '';

      for (const delta of options.deltas ?? []) {
        snapshot += delta;

        for (const listener of textListeners) {
          listener(delta, snapshot);
        }
      }

      if (options.finalError) {
        throw options.finalError;
      }

      return options.finalMessage as Anthropic.Messages.Message;
    },
  };
};

const MODEL_MAIN = 'claude-main-test';
const MODEL_BACKGROUND = 'claude-bg-test';
const DEFAULT_MAX_TOKENS = 555;
const MAX_RETRIES = 4;

/**
 * Builds an `AiConfig` test double returning fixed model ids and limits without
 * touching `ConfigService`.
 */
const buildConfig = (): AiConfig =>
  ({
    getProvider: () => AiProvider.ANTHROPIC,
    getAnthropicApiKey: () => 'test-key',
    getModelId: (role: AiModelRole) =>
      role === AiModelRole.MAIN ? MODEL_MAIN : MODEL_BACKGROUND,
    getMaxOutputTokens: () => DEFAULT_MAX_TOKENS,
    getMaxRetries: () => MAX_RETRIES,
  }) as unknown as AiConfig;

/**
 * Builds a canned `text` content block (the SDK requires the `citations` field).
 */
const textBlock = (text: string): Anthropic.Messages.TextBlock => ({
  type: 'text',
  text,
  citations: null,
});

/**
 * Builds a canned `tool_use` content block. The SDK's `ToolUseBlock` requires a
 * `caller`; a direct caller is the shape the model returns for client tools.
 */
const toolUseBlock = (
  id: string,
  name: string,
  input: Record<string, unknown>,
): Anthropic.Messages.ToolUseBlock => ({
  type: 'tool_use',
  id,
  name,
  input,
  caller: { type: 'direct' },
});

/**
 * Convenience builder for a canned Anthropic `Message` response.
 */
const buildMessage = (
  overrides: Partial<Anthropic.Messages.Message>,
): Anthropic.Messages.Message =>
  ({
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: MODEL_MAIN,
    stop_reason: 'end_turn',
    stop_sequence: null,
    stop_details: null,
    container: null,
    content: [],
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_creation: null,
      server_tool_use: null,
      service_tier: null,
    },
    ...overrides,
  }) as Anthropic.Messages.Message;

describe('AnthropicAiConnector', () => {
  let connector: AnthropicAiConnector;

  beforeEach(() => {
    AnthropicMock.mockClear();
    connector = new AnthropicAiConnector(buildConfig());

    const client = AnthropicMock.mock.results.at(-1)?.value as {
      messages: { create: jest.Mock };
      beta: { messages: { create: jest.Mock } };
    };

    messagesCreate = client.messages.create;
    betaMessagesCreate = client.beta.messages.create;

    const streamingClient = AnthropicMock.mock.results.at(-1)?.value as {
      messages: { stream: jest.Mock };
      beta: { messages: { stream: jest.Mock } };
    };

    messagesStream = streamingClient.messages.stream;
    betaMessagesStream = streamingClient.beta.messages.stream;
  });

  it('declares the Anthropic provider and full capabilities', () => {
    expect(connector.provider).toBe(AiProvider.ANTHROPIC);
    expect(connector.capabilities).toEqual({
      promptCaching: true,
      contextEditing: true,
      structuredOutput: true,
    });
  });

  it('constructs the SDK client with the configured api key and maxRetries', () => {
    expect(AnthropicMock).toHaveBeenCalledTimes(1);
    expect(AnthropicMock).toHaveBeenCalledWith({
      apiKey: 'test-key',
      maxRetries: MAX_RETRIES,
    });
  });

  describe('complete', () => {
    it('returns normalized text result with usage on an end_turn response', async () => {
      messagesCreate.mockResolvedValue(
        buildMessage({
          stop_reason: 'end_turn',
          content: [textBlock('Done.')],
          usage: {
            input_tokens: 120,
            output_tokens: 8,
            cache_read_input_tokens: 100,
            cache_creation_input_tokens: 20,
            cache_creation: null,
            server_tool_use: null,
            service_tier: null,
          } as Anthropic.Messages.Usage,
        }),
      );

      const request: CompletionRequest = {
        modelRole: AiModelRole.MAIN,
        messages: [{ role: PromptRole.USER, content: 'hi' }],
      };

      const result = await connector.complete(request);

      expect(result.stopReason).toBe(AiStopReason.END_TURN);
      expect(result.text).toBe('Done.');
      expect(result.toolCalls).toBeUndefined();
      expect(result.usage).toEqual({
        inputTokens: 120,
        outputTokens: 8,
        cacheReadTokens: 100,
        cacheWriteTokens: 20,
      });
    });

    it('populates toolCalls and stopReason tool_use on a tool_use response', async () => {
      messagesCreate.mockResolvedValue(
        buildMessage({
          stop_reason: 'tool_use',
          content: [
            textBlock('Checking…'),
            toolUseBlock('toolu_1', 'list_events', { date: '2026-06-02' }),
          ],
        }),
      );

      const result = await connector.complete({
        modelRole: AiModelRole.MAIN,
        messages: [{ role: PromptRole.USER, content: 'free thursday?' }],
      });

      expect(result.stopReason).toBe(AiStopReason.TOOL_USE);
      expect(result.toolCalls).toEqual([
        { id: 'toolu_1', name: 'list_events', input: { date: '2026-06-02' } },
      ]);
      expect(result.text).toBe('Checking…');
    });

    it('maps modelRole to the configured model id (no hardcoded strings)', async () => {
      messagesCreate.mockResolvedValue(buildMessage({}));

      await connector.complete({
        modelRole: AiModelRole.BACKGROUND,
        messages: [{ role: PromptRole.USER, content: 'x' }],
      });

      expect(messagesCreate.mock.calls[0][0].model).toBe(MODEL_BACKGROUND);
    });

    it('falls back to the configured max output tokens when unspecified', async () => {
      messagesCreate.mockResolvedValue(buildMessage({}));

      await connector.complete({
        modelRole: AiModelRole.MAIN,
        messages: [{ role: PromptRole.USER, content: 'x' }],
      });

      expect(messagesCreate.mock.calls[0][0].max_tokens).toBe(
        DEFAULT_MAX_TOKENS,
      );
    });

    it('maps system, messages, and tools into the request body', async () => {
      messagesCreate.mockResolvedValue(buildMessage({}));

      await connector.complete({
        modelRole: AiModelRole.MAIN,
        system: [{ role: PromptRole.USER, content: 'You are Cue.' }],
        messages: [
          { role: PromptRole.USER, content: 'first' },
          { role: PromptRole.ASSISTANT, content: 'reply' },
        ],
        tools: [
          {
            name: 'list_events',
            description: 'list',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      });

      const body = messagesCreate.mock.calls[0][0];

      expect(body.system).toEqual([{ type: 'text', text: 'You are Cue.' }]);
      expect(body.messages).toEqual([
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply' },
      ]);
      expect(body.tools).toEqual([
        {
          name: 'list_events',
          description: 'list',
          input_schema: { type: 'object', properties: {} },
        },
      ]);
    });

    it('sets cache_control only on flagged blocks when promptCaching is on', async () => {
      messagesCreate.mockResolvedValue(buildMessage({}));

      await connector.complete({
        modelRole: AiModelRole.MAIN,
        system: [
          { role: PromptRole.USER, content: 'persona' },
          { role: PromptRole.USER, content: 'profile', cacheBoundary: true },
        ],
        messages: [
          { role: PromptRole.USER, content: 'now', cacheBoundary: true },
        ],
        tools: [
          {
            name: 'list_events',
            description: 'list',
            inputSchema: { type: 'object', properties: {} },
            cacheBoundary: true,
          },
        ],
        features: { promptCaching: true },
      });

      const body = messagesCreate.mock.calls[0][0];

      // System: only the second (flagged) block carries cache_control.
      expect(body.system[0].cache_control).toBeUndefined();
      expect(body.system[1].cache_control).toEqual({ type: 'ephemeral' });
      // Tool: flagged → cache_control present.
      expect(body.tools[0].cache_control).toEqual({ type: 'ephemeral' });
      // Message: flagged → becomes a content array with cache_control.
      expect(body.messages[0].content[0].cache_control).toEqual({
        type: 'ephemeral',
      });
    });

    it('omits cache_control entirely when promptCaching is off', async () => {
      messagesCreate.mockResolvedValue(buildMessage({}));

      await connector.complete({
        modelRole: AiModelRole.MAIN,
        system: [{ role: PromptRole.USER, content: 'p', cacheBoundary: true }],
        messages: [
          { role: PromptRole.USER, content: 'm', cacheBoundary: true },
        ],
        tools: [
          {
            name: 't',
            description: 'd',
            inputSchema: { type: 'object' },
            cacheBoundary: true,
          },
        ],
      });

      const body = messagesCreate.mock.calls[0][0];

      expect(body.system[0].cache_control).toBeUndefined();
      expect(body.tools[0].cache_control).toBeUndefined();
      expect(typeof body.messages[0].content).toBe('string');
    });

    it('renders a single tool round as assistant(tool_use) then user(tool_result)', async () => {
      messagesCreate.mockResolvedValue(buildMessage({}));

      await connector.complete({
        modelRole: AiModelRole.MAIN,
        messages: [{ role: PromptRole.USER, content: 'book it' }],
        toolRounds: [
          {
            assistantText: 'Checking your calendar…',
            toolCalls: [
              { id: 'toolu_1', name: 'list_events', input: { date: 'today' } },
            ],
            toolResults: [
              { toolCallId: 'toolu_1', content: '[]', isError: false },
            ],
          },
        ],
      });

      const body = messagesCreate.mock.calls[0][0];

      // [ user(book it), assistant(text + tool_use), user(tool_result) ]
      expect(body.messages).toHaveLength(3);

      const assistantTurn = body.messages[1];

      expect(assistantTurn.role).toBe('assistant');
      expect(assistantTurn.content).toEqual([
        { type: 'text', text: 'Checking your calendar…' },
        {
          type: 'tool_use',
          id: 'toolu_1',
          name: 'list_events',
          input: { date: 'today' },
        },
      ]);

      const resultTurn = body.messages[2];

      expect(resultTurn.role).toBe('user');
      expect(resultTurn.content).toEqual([
        {
          type: 'tool_result',
          tool_use_id: 'toolu_1',
          content: '[]',
          is_error: false,
        },
      ]);
    });

    it('renders multiple tool rounds with each tool_result following its matching tool_use turn', async () => {
      messagesCreate.mockResolvedValue(buildMessage({}));

      await connector.complete({
        modelRole: AiModelRole.MAIN,
        messages: [{ role: PromptRole.USER, content: 'find me a free hour' }],
        toolRounds: [
          {
            toolCalls: [
              { id: 'toolu_a', name: 'list_events', input: { day: 'mon' } },
            ],
            toolResults: [
              { toolCallId: 'toolu_a', content: 'busy 9-10', isError: false },
            ],
          },
          {
            toolCalls: [
              { id: 'toolu_b', name: 'list_events', input: { day: 'tue' } },
            ],
            toolResults: [
              { toolCallId: 'toolu_b', content: 'free all day', isError: true },
            ],
          },
        ],
      });

      const body = messagesCreate.mock.calls[0][0];

      // [ user, assistant(tool_use a), user(result a), assistant(tool_use b), user(result b) ]
      expect(body.messages).toHaveLength(5);

      // Round 1: assistant tool_use precedes its tool_result, ids match.
      expect(body.messages[1].role).toBe('assistant');
      expect(body.messages[1].content[0]).toMatchObject({
        type: 'tool_use',
        id: 'toolu_a',
      });
      expect(body.messages[2].role).toBe('user');
      expect(body.messages[2].content[0]).toMatchObject({
        type: 'tool_result',
        tool_use_id: 'toolu_a',
      });

      // Round 2: same, with the second id pair; is_error carried through.
      expect(body.messages[3].role).toBe('assistant');
      expect(body.messages[3].content[0]).toMatchObject({
        type: 'tool_use',
        id: 'toolu_b',
      });
      expect(body.messages[4].role).toBe('user');
      expect(body.messages[4].content[0]).toMatchObject({
        type: 'tool_result',
        tool_use_id: 'toolu_b',
        is_error: true,
      });

      // The id pairing the live API enforces: every tool_result references the
      // tool_use that immediately precedes it.
      expect(body.messages[2].content[0].tool_use_id).toBe(
        body.messages[1].content[0].id,
      );
      expect(body.messages[4].content[0].tool_use_id).toBe(
        body.messages[3].content[0].id,
      );
    });

    it('omits the assistant text block when a tool round has no assistantText', async () => {
      messagesCreate.mockResolvedValue(buildMessage({}));

      await connector.complete({
        modelRole: AiModelRole.MAIN,
        messages: [{ role: PromptRole.USER, content: 'x' }],
        toolRounds: [
          {
            toolCalls: [{ id: 'toolu_1', name: 'list_events', input: {} }],
            toolResults: [{ toolCallId: 'toolu_1', content: '[]' }],
          },
        ],
      });

      const body = messagesCreate.mock.calls[0][0];
      const assistantTurn = body.messages[1];

      expect(assistantTurn.content).toHaveLength(1);
      expect(assistantTurn.content[0].type).toBe('tool_use');
    });

    it('routes through the beta endpoint with the context-management beta when contextEditing is on', async () => {
      betaMessagesCreate.mockResolvedValue(buildMessage({}));

      await connector.complete({
        modelRole: AiModelRole.MAIN,
        messages: [{ role: PromptRole.USER, content: 'x' }],
        features: { contextEditing: true },
      });

      expect(messagesCreate).not.toHaveBeenCalled();
      expect(betaMessagesCreate).toHaveBeenCalledTimes(1);

      const body = betaMessagesCreate.mock.calls[0][0];

      expect(body.betas).toContain('context-management-2025-06-27');
      expect(body.context_management).toEqual({
        edits: [{ type: 'clear_tool_uses_20250919' }],
      });
    });

    it('translates toolChoice "any" into {type:"any"} when tools are present', async () => {
      messagesCreate.mockResolvedValue(buildMessage({}));

      await connector.complete({
        modelRole: AiModelRole.MAIN,
        messages: [{ role: PromptRole.USER, content: 'do it' }],
        tools: [
          {
            name: 'create_task',
            description: 'create',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
        toolChoice: 'any',
      });

      expect(messagesCreate.mock.calls[0][0].tool_choice).toEqual({
        type: 'any',
      });
    });

    it('translates toolChoice {name} into {type:"tool",name} when tools are present', async () => {
      messagesCreate.mockResolvedValue(buildMessage({}));

      await connector.complete({
        modelRole: AiModelRole.MAIN,
        messages: [{ role: PromptRole.USER, content: 'create it' }],
        tools: [
          {
            name: 'create_task',
            description: 'create',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
        toolChoice: { name: 'create_task' },
      });

      expect(messagesCreate.mock.calls[0][0].tool_choice).toEqual({
        type: 'tool',
        name: 'create_task',
      });
    });

    it('translates toolChoice "auto" into {type:"auto"} when tools are present', async () => {
      messagesCreate.mockResolvedValue(buildMessage({}));

      await connector.complete({
        modelRole: AiModelRole.MAIN,
        messages: [{ role: PromptRole.USER, content: 'maybe' }],
        tools: [
          {
            name: 'create_task',
            description: 'create',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
        toolChoice: 'auto',
      });

      expect(messagesCreate.mock.calls[0][0].tool_choice).toEqual({
        type: 'auto',
      });
    });

    it('omits tool_choice entirely when toolChoice is unset (implicit auto)', async () => {
      messagesCreate.mockResolvedValue(buildMessage({}));

      await connector.complete({
        modelRole: AiModelRole.MAIN,
        messages: [{ role: PromptRole.USER, content: 'hi' }],
        tools: [
          {
            name: 'create_task',
            description: 'create',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      });

      expect(messagesCreate.mock.calls[0][0].tool_choice).toBeUndefined();
    });

    it('degrades a forced toolChoice to an omitted choice when there are no tools (never throws)', async () => {
      messagesCreate.mockResolvedValue(buildMessage({}));

      await connector.complete({
        modelRole: AiModelRole.MAIN,
        messages: [{ role: PromptRole.USER, content: 'no tools available' }],
        toolChoice: 'any',
      });

      const body = messagesCreate.mock.calls[0][0];

      expect(body.tool_choice).toBeUndefined();
      expect(body.tools).toBeUndefined();
    });

    it('propagates raw SDK errors (no retry/wrapping in the connector)', async () => {
      const sdkError = new Error('429 rate limited');

      messagesCreate.mockRejectedValue(sdkError);

      await expect(
        connector.complete({
          modelRole: AiModelRole.MAIN,
          messages: [{ role: PromptRole.USER, content: 'x' }],
        }),
      ).rejects.toBe(sdkError);
      expect(messagesCreate).toHaveBeenCalledTimes(1);
    });

    it('on a 529 on MAIN, retries once on the BACKGROUND model id and succeeds (Story 3b)', async () => {
      const overload = new MockAnthropicApiError(
        529,
        'overloaded_error',
        'req_overloaded',
        '529 Overloaded',
      );

      messagesCreate.mockRejectedValueOnce(overload).mockResolvedValueOnce(
        buildMessage({
          stop_reason: 'end_turn',
          model: MODEL_BACKGROUND,
          content: [textBlock('Recovered on fallback.')],
        }),
      );

      const result = await connector.complete({
        modelRole: AiModelRole.MAIN,
        messages: [{ role: PromptRole.USER, content: 'do it' }],
      });

      // One failed MAIN attempt + one fallback attempt.
      expect(messagesCreate).toHaveBeenCalledTimes(2);
      // The first call targets MAIN; the retry swaps to the BACKGROUND model id.
      expect(messagesCreate.mock.calls[0][0].model).toBe(MODEL_MAIN);
      expect(messagesCreate.mock.calls[1][0].model).toBe(MODEL_BACKGROUND);
      // The loop never sees the 529 — it gets the fallback's result.
      expect(result.stopReason).toBe(AiStopReason.END_TURN);
      expect(result.text).toBe('Recovered on fallback.');
    });

    it('on a 529 on both MAIN and the fallback, rethrows the fallback error raw (Story 3b)', async () => {
      const mainOverload = new MockAnthropicApiError(
        529,
        'overloaded_error',
        'req_main',
        '529 Overloaded',
      );
      const fallbackOverload = new MockAnthropicApiError(
        529,
        'overloaded_error',
        'req_fallback',
        '529 Overloaded again',
      );

      messagesCreate
        .mockRejectedValueOnce(mainOverload)
        .mockRejectedValueOnce(fallbackOverload);

      await expect(
        connector.complete({
          modelRole: AiModelRole.MAIN,
          messages: [{ role: PromptRole.USER, content: 'do it' }],
        }),
      ).rejects.toBe(fallbackOverload);

      // MAIN attempt + one fallback attempt, then it gives up.
      expect(messagesCreate).toHaveBeenCalledTimes(2);
      expect(messagesCreate.mock.calls[1][0].model).toBe(MODEL_BACKGROUND);
    });

    it('does not fall back on a non-529 failure on MAIN — rethrows raw (Story 3b)', async () => {
      const serverError = new MockAnthropicApiError(
        500,
        'api_error',
        'req_500',
        '500 Internal',
      );

      messagesCreate.mockRejectedValue(serverError);

      await expect(
        connector.complete({
          modelRole: AiModelRole.MAIN,
          messages: [{ role: PromptRole.USER, content: 'do it' }],
        }),
      ).rejects.toBe(serverError);

      // No fallback attempt — exactly one call.
      expect(messagesCreate).toHaveBeenCalledTimes(1);
    });

    it('does not fall back when a 529 hits a BACKGROUND request — only MAIN swaps (Story 3b)', async () => {
      const overload = new MockAnthropicApiError(
        529,
        'overloaded_error',
        'req_bg',
        '529 Overloaded',
      );

      messagesCreate.mockRejectedValue(overload);

      await expect(
        connector.complete({
          modelRole: AiModelRole.BACKGROUND,
          messages: [{ role: PromptRole.USER, content: 'summarize' }],
        }),
      ).rejects.toBe(overload);

      // BACKGROUND is not eligible for the fallback swap — one call only.
      expect(messagesCreate).toHaveBeenCalledTimes(1);
    });

    it('falls back on a 529 whose status was dropped mid-stream (body marker only) (Story 3b)', async () => {
      // The SDK sometimes surfaces an overload as a plain Error carrying the body
      // string with no 529 status — is529 must still recognize it.
      const droppedStatusOverload = new Error(
        'stream error: {"type":"error","error":{"type":"overloaded_error"}}',
      );

      messagesCreate
        .mockRejectedValueOnce(droppedStatusOverload)
        .mockResolvedValueOnce(
          buildMessage({
            stop_reason: 'end_turn',
            model: MODEL_BACKGROUND,
            content: [textBlock('Recovered.')],
          }),
        );

      const result = await connector.complete({
        modelRole: AiModelRole.MAIN,
        messages: [{ role: PromptRole.USER, content: 'do it' }],
      });

      expect(messagesCreate).toHaveBeenCalledTimes(2);
      expect(messagesCreate.mock.calls[1][0].model).toBe(MODEL_BACKGROUND);
      expect(result.text).toBe('Recovered.');
    });

    it('logs an error with operation + status then rethrows on an APIError', async () => {
      const errorSpy = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      const apiError = new MockAnthropicApiError(
        529,
        'overloaded_error',
        'req_overloaded',
        '529 Overloaded',
      );

      messagesCreate.mockRejectedValue(apiError);

      // BACKGROUND is used here (not MAIN) so the 529 is NOT eligible for the
      // Story-3b fallback swap — this test asserts the single error-log format +
      // redaction, which only holds on the no-fallback path.
      await expect(
        connector.complete({
          modelRole: AiModelRole.BACKGROUND,
          messages: [
            { role: PromptRole.USER, content: 'SECRET_PROMPT_CONTENT' },
          ],
        }),
      ).rejects.toBe(apiError);

      expect(errorSpy).toHaveBeenCalledTimes(1);

      const logged = errorSpy.mock.calls[0][0] as string;

      expect(logged).toContain('operation=complete');
      expect(logged).toContain('status=529');
      expect(logged).toContain('errorType=overloaded_error');
      expect(logged).toContain('requestId=req_overloaded');
      expect(logged).toContain('retryable=true');
      // Redaction: the prompt text must never reach the log.
      expect(logged).not.toContain('SECRET_PROMPT_CONTENT');

      errorSpy.mockRestore();
    });
  });

  describe('completeStream (Story 13 / ADR 0041)', () => {
    it('streams text deltas via onText and returns the same normalized result complete() would', async () => {
      messagesStream.mockReturnValue(
        fakeMessageStream({
          deltas: ['He', 'llo'],
          finalMessage: buildMessage({
            stop_reason: 'end_turn',
            content: [textBlock('Hello')],
            usage: {
              input_tokens: 30,
              output_tokens: 4,
              cache_read_input_tokens: 10,
              cache_creation_input_tokens: 0,
              cache_creation: null,
              server_tool_use: null,
              service_tier: null,
            } as Anthropic.Messages.Usage,
          }),
        }),
      );

      const deltas: Array<{ delta: string; snapshot: string }> = [];
      const result = await connector.completeStream(
        {
          modelRole: AiModelRole.MAIN,
          messages: [{ role: PromptRole.USER, content: 'hi' }],
        },
        (delta, snapshot) => deltas.push({ delta, snapshot }),
      );

      // onText saw each incremental delta + the running snapshot.
      expect(deltas).toEqual([
        { delta: 'He', snapshot: 'He' },
        { delta: 'llo', snapshot: 'Hello' },
      ]);
      // Same normalized shape as complete(): stopReason / text / usage.
      expect(result.stopReason).toBe(AiStopReason.END_TURN);
      expect(result.text).toBe('Hello');
      expect(result.usage).toEqual({
        inputTokens: 30,
        outputTokens: 4,
        cacheReadTokens: 10,
        cacheWriteTokens: 0,
      });
      // It streamed (no non-streamed create on the happy path).
      expect(messagesStream).toHaveBeenCalledTimes(1);
      expect(messagesCreate).not.toHaveBeenCalled();
    });

    it('RETURNS, NEVER THROWS on a stream error — reconciles to a non-streamed complete() fallback', async () => {
      // The stream rejects mid-flight (after emitting a partial delta)…
      messagesStream.mockReturnValue(
        fakeMessageStream({
          deltas: ['parti'],
          finalError: new Error('stream connection dropped'),
        }),
      );
      // …and the non-streamed fallback succeeds with the full answer.
      messagesCreate.mockResolvedValue(
        buildMessage({
          stop_reason: 'end_turn',
          content: [textBlock('partial recovered in full')],
        }),
      );

      const seen: string[] = [];
      let result:
        | Awaited<ReturnType<typeof connector.completeStream>>
        | undefined;

      // Must not throw — the loop is attempts:1.
      await expect(
        (async () => {
          result = await connector.completeStream(
            {
              modelRole: AiModelRole.MAIN,
              messages: [{ role: PromptRole.USER, content: 'go' }],
            },
            (_delta, snapshot) => seen.push(snapshot),
          );
        })(),
      ).resolves.toBeUndefined();

      // The partial delta still reached the caller before the fault…
      expect(seen).toEqual(['parti']);
      // …and the returned result is the non-streamed fallback's answer.
      expect(result?.stopReason).toBe(AiStopReason.END_TURN);
      expect(result?.text).toBe('partial recovered in full');
      expect(messagesStream).toHaveBeenCalledTimes(1);
      expect(messagesCreate).toHaveBeenCalledTimes(1);
    });

    it('on an empty stream, falls back to a non-streamed complete() and returns its result', async () => {
      // The stream produces no deltas and a final message with no text.
      messagesStream.mockReturnValue(
        fakeMessageStream({
          deltas: [],
          finalError: new Error('empty stream: no content produced'),
        }),
      );
      messagesCreate.mockResolvedValue(
        buildMessage({
          stop_reason: 'end_turn',
          content: [textBlock('answer from the fallback')],
        }),
      );

      const result = await connector.completeStream(
        {
          modelRole: AiModelRole.MAIN,
          messages: [{ role: PromptRole.USER, content: 'q' }],
        },
        () => undefined,
      );

      expect(result.text).toBe('answer from the fallback');
      expect(messagesCreate).toHaveBeenCalledTimes(1);
    });

    it('returns a best-effort partial (never throws) when BOTH the stream and the fallback fail', async () => {
      messagesStream.mockReturnValue(
        fakeMessageStream({
          deltas: ['half-written '],
          finalError: new Error('stream died'),
        }),
      );
      // The non-streamed fallback ALSO fails — the floor must still return.
      messagesCreate.mockRejectedValue(new Error('fallback also down'));

      const result = await connector.completeStream(
        {
          modelRole: AiModelRole.MAIN,
          messages: [{ role: PromptRole.USER, content: 'go' }],
        },
        () => undefined,
      );

      // A valid result built from whatever streamed — OTHER stop reason, partial text.
      expect(result.stopReason).toBe(AiStopReason.OTHER);
      expect(result.text).toBe('half-written ');
      expect(result.usage).toEqual({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      });
    });

    it('swallows a throwing onText handler so streaming degrades instead of aborting the turn', async () => {
      messagesStream.mockReturnValue(
        fakeMessageStream({
          deltas: ['x', 'y'],
          finalMessage: buildMessage({
            stop_reason: 'end_turn',
            content: [textBlock('xy')],
          }),
        }),
      );

      const result = await connector.completeStream(
        {
          modelRole: AiModelRole.MAIN,
          messages: [{ role: PromptRole.USER, content: 'hi' }],
        },
        () => {
          throw new Error('render blew up');
        },
      );

      // The throwing handler did not abort the stream — we still get the answer.
      expect(result.text).toBe('xy');
      expect(messagesCreate).not.toHaveBeenCalled();
    });

    it('routes a context-edited turn through the beta stream endpoint', async () => {
      betaMessagesStream.mockReturnValue(
        fakeMessageStream({
          deltas: ['done'],
          finalMessage: buildMessage({
            stop_reason: 'end_turn',
            content: [textBlock('done')],
          }),
        }),
      );

      const result = await connector.completeStream(
        {
          modelRole: AiModelRole.MAIN,
          messages: [{ role: PromptRole.USER, content: 'edit' }],
          features: { contextEditing: true },
        },
        () => undefined,
      );

      expect(result.text).toBe('done');
      expect(betaMessagesStream).toHaveBeenCalledTimes(1);
      expect(messagesStream).not.toHaveBeenCalled();

      // The beta stream carried the context-management beta + clear-tool-uses edit.
      const betaBody = betaMessagesStream.mock.calls[0][0];

      expect(betaBody.betas).toContain('context-management-2025-06-27');
    });
  });

  describe('completeStructured', () => {
    const schema = z.object({
      summary: z.string(),
      turns: z.number(),
    });

    it('returns the validated object from the forced tool call', async () => {
      messagesCreate.mockResolvedValue(
        buildMessage({
          stop_reason: 'tool_use',
          content: [
            toolUseBlock('toolu_struct', 'respond_with_structured_output', {
              summary: 'all good',
              turns: 3,
            }),
          ],
        }),
      );

      const result = await connector.completeStructured(
        {
          modelRole: AiModelRole.BACKGROUND,
          messages: [{ role: PromptRole.USER, content: 'summarize' }],
        },
        schema,
      );

      expect(result).toEqual({ summary: 'all good', turns: 3 });

      // It must force the tool choice and pass a derived JSON schema.
      const body = messagesCreate.mock.calls[0][0];

      expect(body.tool_choice).toEqual({
        type: 'tool',
        name: 'respond_with_structured_output',
      });
      expect(body.tools[0].input_schema.type).toBe('object');
      expect(body.tools[0].input_schema.properties).toHaveProperty('summary');
      expect(body.tools[0].input_schema.properties).toHaveProperty('turns');
    });

    it('retries once then succeeds when the first result is schema-invalid', async () => {
      messagesCreate
        .mockResolvedValueOnce(
          buildMessage({
            stop_reason: 'tool_use',
            content: [
              toolUseBlock('bad', 'respond_with_structured_output', {
                summary: 'missing turns',
              }),
            ],
          }),
        )
        .mockResolvedValueOnce(
          buildMessage({
            stop_reason: 'tool_use',
            content: [
              toolUseBlock('good', 'respond_with_structured_output', {
                summary: 'ok',
                turns: 2,
              }),
            ],
          }),
        );

      const result = await connector.completeStructured(
        {
          modelRole: AiModelRole.BACKGROUND,
          messages: [{ role: PromptRole.USER, content: 'summarize' }],
        },
        schema,
      );

      expect(result).toEqual({ summary: 'ok', turns: 2 });
      expect(messagesCreate).toHaveBeenCalledTimes(2);
    });

    it('throws after exhausting retries on persistently invalid output', async () => {
      messagesCreate.mockResolvedValue(
        buildMessage({
          stop_reason: 'tool_use',
          content: [
            toolUseBlock('bad', 'respond_with_structured_output', {
              summary: 123,
            }),
          ],
        }),
      );

      await expect(
        connector.completeStructured(
          {
            modelRole: AiModelRole.BACKGROUND,
            messages: [{ role: PromptRole.USER, content: 'summarize' }],
          },
          schema,
        ),
      ).rejects.toBeInstanceOf(Error);
      // Initial attempt + one retry.
      expect(messagesCreate).toHaveBeenCalledTimes(2);
    });

    it('logs an error with operation=completeStructured + status and rethrows immediately on an APIError', async () => {
      const errorSpy = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      const apiError = new MockAnthropicApiError(
        529,
        'overloaded_error',
        'req_struct',
        '529 Overloaded',
      );

      messagesCreate.mockRejectedValue(apiError);

      await expect(
        connector.completeStructured(
          {
            modelRole: AiModelRole.BACKGROUND,
            messages: [{ role: PromptRole.USER, content: 'summarize' }],
          },
          schema,
        ),
      ).rejects.toBe(apiError);

      // An API error propagates immediately — no structured re-ask loop.
      expect(messagesCreate).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledTimes(1);

      const logged = errorSpy.mock.calls[0][0] as string;

      expect(logged).toContain('operation=completeStructured');
      expect(logged).toContain('status=529');

      errorSpy.mockRestore();
    });
  });
});

describe('is529', () => {
  it('matches an APIError carrying HTTP status 529', () => {
    const overload = new MockAnthropicApiError(
      529,
      'overloaded_error',
      'req_overloaded',
      '529 Overloaded',
    );

    expect(is529(overload)).toBe(true);
  });

  it('matches by the "overloaded_error" body substring when the status was dropped', () => {
    // A 529 the SDK surfaced mid-stream with no status, only the body string.
    const droppedStatus = new Error(
      'stream error: {"type":"error","error":{"type":"overloaded_error"}}',
    );

    expect(is529(droppedStatus)).toBe(true);
  });

  it('does not match a non-529 APIError (e.g. a 500 with no overload marker)', () => {
    const serverError = new MockAnthropicApiError(
      500,
      'api_error',
      'req_500',
      '500 Internal Server Error',
    );

    expect(is529(serverError)).toBe(false);
  });

  it('does not match a plain non-overload error', () => {
    expect(is529(new Error('429 rate limited'))).toBe(false);
    expect(is529('some string failure')).toBe(false);
  });
});
