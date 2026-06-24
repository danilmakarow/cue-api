import { ToolLoopService } from './tool-loop.service';
import { TurnStreamSink } from '../assistant.types';
import {
  AiStopReason,
  CompletionResult,
  StreamTextHandler,
} from '@/modules/ai/ai.types';
import { User } from '@/modules/database/entities';

/**
 * Builds a bare CompletionResult with zeroed usage, overlaid with the given
 * fields, so each test states only what it cares about.
 */
const completion = (over: Partial<CompletionResult>): CompletionResult => ({
  stopReason: AiStopReason.END_TURN,
  usage: {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  },
  ...over,
});

const USER = { id: 'user-1', timezone: 'UTC' } as User;

/**
 * Assembles a ToolLoopService with jest mocks for every collaborator. The AI
 * `completeStream` is programmable per test: its default replays the resolved
 * result's text through `onText` (delta = snapshot = the full text) so the
 * streaming seam can be observed; tests that need a custom delta sequence override
 * the implementation. Exposes the mocks for assertions.
 */
const buildHarness = () => {
  const completeStream = jest.fn(
    async (
      _request: unknown,
      onText: StreamTextHandler,
    ): Promise<CompletionResult> => {
      const result = completion({
        stopReason: AiStopReason.END_TURN,
        text: 'Hi',
      });

      onText('Hi', 'Hi');

      return result;
    },
  );
  const ai = {
    complete: jest.fn(),
    completeStructured: jest.fn(),
    completeStream,
  };
  const config = {
    maxToolRoundtrips: 8,
    maxScheduleFetches: 5,
    maxCorrections: 5,
  };
  const contextBuilder = {
    build: jest.fn().mockResolvedValue({ system: [], messages: [], tools: [] }),
  };
  const toolDispatcher = { dispatch: jest.fn() };
  const roundRecap = { recapRound: jest.fn().mockResolvedValue(null) };

  const service = new ToolLoopService(
    ai as never,
    config as never,
    contextBuilder as never,
    toolDispatcher as never,
    roundRecap as never,
  );

  return { service, ai, config, contextBuilder, toolDispatcher, roundRecap };
};

/** Builds a stream sink spy exposing both showRecap and onToken. */
const buildSink = (): TurnStreamSink & {
  showRecap: jest.Mock;
  onToken: jest.Mock;
} => ({
  showRecap: jest.fn(),
  onToken: jest.fn(),
});

describe('ToolLoopService answer streaming (R3 / ADR 0058)', () => {
  it('forwards each onText snapshot to streamSink.onToken', async () => {
    const harness = buildHarness();
    const sink = buildSink();

    // A multi-delta stream: the sink must receive the ACCUMULATED snapshot each time.
    harness.ai.completeStream.mockImplementationOnce(
      async (_request: unknown, onText: StreamTextHandler) => {
        onText('Hel', 'Hel');
        onText('lo', 'Hello');

        return completion({ stopReason: AiStopReason.END_TURN, text: 'Hello' });
      },
    );

    await harness.service.run({
      user: USER,
      conversationId: 'conv-1',
      currentMessageText: 'hi',
      correlationId: 'cid-1',
      streamSink: sink,
    });

    expect(sink.onToken).toHaveBeenCalledTimes(2);
    // The sink receives the SNAPSHOT (accumulated), not the raw delta.
    expect(sink.onToken).toHaveBeenNthCalledWith(1, 'Hel');
    expect(sink.onToken).toHaveBeenNthCalledWith(2, 'Hello');
  });

  it('forwards tokens for a tool_use round too (every round streams)', async () => {
    const harness = buildHarness();
    const sink = buildSink();
    const call = {
      id: 'c1',
      name: 'list_tasks',
      input: { from: 'a', to: 'b' },
    };

    // Round 0: the model narrates while calling a tool — its text still streams.
    harness.ai.completeStream
      .mockImplementationOnce(
        async (_request: unknown, onText: StreamTextHandler) => {
          onText('Checking', 'Checking');

          return completion({
            stopReason: AiStopReason.TOOL_USE,
            text: 'Checking',
            toolCalls: [call],
          });
        },
      )
      .mockImplementationOnce(
        async (_request: unknown, onText: StreamTextHandler) => {
          onText('Done', 'Done');

          return completion({
            stopReason: AiStopReason.END_TURN,
            text: 'Done',
          });
        },
      );
    harness.toolDispatcher.dispatch.mockResolvedValue({ content: 'ok' });

    await harness.service.run({
      user: USER,
      conversationId: 'conv-1',
      currentMessageText: 'check today',
      correlationId: 'cid-2',
      streamSink: sink,
    });

    // Both rounds streamed their text into the sink.
    expect(sink.onToken).toHaveBeenCalledWith('Checking');
    expect(sink.onToken).toHaveBeenCalledWith('Done');
  });

  it('does not throw when the sink has no onToken (optional method) — degrades to no streaming', async () => {
    const harness = buildHarness();
    // A recap-only sink (no onToken) — e.g. a legacy/no-op sink.
    const sink: TurnStreamSink = { showRecap: jest.fn() };

    await expect(
      harness.service.run({
        user: USER,
        conversationId: 'conv-1',
        currentMessageText: 'hi',
        correlationId: 'cid-3',
        streamSink: sink,
      }),
    ).resolves.toMatchObject({ outcome: { kind: 'reply', text: 'Hi' } });
  });

  it('does not throw when there is no stream sink at all', async () => {
    const harness = buildHarness();

    await expect(
      harness.service.run({
        user: USER,
        conversationId: 'conv-1',
        currentMessageText: 'hi',
        correlationId: 'cid-4',
      }),
    ).resolves.toMatchObject({ outcome: { kind: 'reply', text: 'Hi' } });
  });
});
