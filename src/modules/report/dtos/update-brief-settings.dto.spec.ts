import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import {
  BRIEF_CUSTOM_PROMPT_MAX_LENGTH,
  UpdateBriefSettingsDto,
} from './update-brief-settings.dto';

/**
 * Runs a plain payload through {@link UpdateBriefSettingsDto} (transform +
 * validate) and returns the transformed instance plus the set of property names
 * that failed validation (empty when valid).
 */
const run = async (
  payload: Record<string, unknown>,
): Promise<{ instance: UpdateBriefSettingsDto; failing: string[] }> => {
  const instance = plainToInstance(UpdateBriefSettingsDto, payload);
  const errors = await validate(instance);

  return { instance, failing: errors.map((error) => error.property) };
};

describe('UpdateBriefSettingsDto', () => {
  it('accepts and trims a non-empty custom prompt', async () => {
    const { instance, failing } = await run({
      customPrompt: '  Keep it brief.  ',
    });

    expect(failing).toEqual([]);
    expect(instance.customPrompt).toBe('Keep it brief.');
  });

  it('accepts an explicit null (clears the prompt)', async () => {
    const { instance, failing } = await run({ customPrompt: null });

    expect(failing).toEqual([]);
    expect(instance.customPrompt).toBeNull();
  });

  it('normalizes an empty string to null (a clear)', async () => {
    const { instance, failing } = await run({ customPrompt: '' });

    expect(failing).toEqual([]);
    expect(instance.customPrompt).toBeNull();
  });

  it('normalizes a whitespace-only string to null (a clear)', async () => {
    const { instance, failing } = await run({ customPrompt: '   ' });

    expect(failing).toEqual([]);
    expect(instance.customPrompt).toBeNull();
  });

  it('rejects an over-long custom prompt', async () => {
    const tooLong = 'x'.repeat(BRIEF_CUSTOM_PROMPT_MAX_LENGTH + 1);

    const { failing } = await run({ customPrompt: tooLong });

    expect(failing).toContain('customPrompt');
  });

  it('accepts a custom prompt at exactly the max length', async () => {
    const atMax = 'x'.repeat(BRIEF_CUSTOM_PROMPT_MAX_LENGTH);

    const { failing } = await run({ customPrompt: atMax });

    expect(failing).toEqual([]);
  });

  it('rejects a non-string, non-null customPrompt', async () => {
    const { failing } = await run({ customPrompt: 42 });

    expect(failing).toContain('customPrompt');
  });
});
