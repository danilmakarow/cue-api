import { RoundRecapService } from './round-recap.service';
import { ToolStepRecord } from '../assistant.types';
import { AiModelRole } from '@/modules/ai/ai.types';

/**
 * Builds a {@link ToolStepRecord} with sensible defaults so a test states only
 * what it cares about.
 */
const step = (over: Partial<ToolStepRecord> = {}): ToolStepRecord => ({
  name: 'list_tasks',
  input: {},
  resultContent: '2 events Thursday',
  isError: false,
  held: false,
  ...over,
});

describe('RoundRecapService (Story 13 / ADR 0041)', () => {
  const buildHarness = () => {
    const ai = { complete: jest.fn(), completeStructured: jest.fn() };
    const service = new RoundRecapService(ai as never);

    return { ai, service };
  };

  it('uses the BACKGROUND model and returns a trimmed one-sentence recap', async () => {
    const { ai, service } = buildHarness();

    ai.complete.mockResolvedValue({
      stopReason: 'end_turn',
      text: '  Checking Thursday afternoon  ',
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    });

    const recap = await service.recapRound([step()], 'cid-1');

    expect(recap).toBe('Checking Thursday afternoon');
    // The recap MUST run on the cheap BACKGROUND (Haiku) model, not MAIN.
    expect(ai.complete).toHaveBeenCalledTimes(1);
    expect(ai.complete.mock.calls[0][0].modelRole).toBe(AiModelRole.BACKGROUND);
    expect(ai.complete.mock.calls[0][0].traceId).toBe('cid-1');
  });

  it('DEGRADES to null (never throws) when the background model fails', async () => {
    const { ai, service } = buildHarness();

    ai.complete.mockRejectedValue(new Error('haiku unavailable'));

    let recap: string | null = 'sentinel';

    await expect(
      (async () => {
        recap = await service.recapRound([step()], 'cid-2');
      })(),
    ).resolves.toBeUndefined();

    expect(recap).toBeNull();
  });

  it('returns null without calling the model when the round has no steps', async () => {
    const { ai, service } = buildHarness();

    const recap = await service.recapRound([], 'cid-3');

    expect(recap).toBeNull();
    expect(ai.complete).not.toHaveBeenCalled();
  });

  it('returns null when the model produces no text', async () => {
    const { ai, service } = buildHarness();

    ai.complete.mockResolvedValue({
      stopReason: 'end_turn',
      text: undefined,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    });

    const recap = await service.recapRound([step()], 'cid-4');

    expect(recap).toBeNull();
  });

  it('caps a verbose recap so it cannot overflow the draft', async () => {
    const { ai, service } = buildHarness();
    const longText = 'a'.repeat(500);

    ai.complete.mockResolvedValue({
      stopReason: 'end_turn',
      text: longText,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    });

    const recap = await service.recapRound([step()], 'cid-5');

    expect(recap).not.toBeNull();
    expect(recap?.length).toBeLessThanOrEqual(120);
  });
});
