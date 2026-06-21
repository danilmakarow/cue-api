import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import {
  PERSONA_PROMPT_MAX_LENGTH,
  UpdatePersonaSettingsDto,
} from './update-persona-settings.dto';

/**
 * Validates a plain payload through {@link UpdatePersonaSettingsDto} and returns
 * the set of property names that failed validation (empty when valid).
 */
const failingProps = async (
  payload: Record<string, unknown>,
): Promise<string[]> => {
  const instance = plainToInstance(UpdatePersonaSettingsDto, payload);
  const errors = await validate(instance);

  return errors.map((error) => error.property);
};

describe('UpdatePersonaSettingsDto (Story 18 / ADR 0014)', () => {
  it('accepts a non-empty persona text', async () => {
    expect(await failingProps({ promptText: 'A dry English butler.' })).toEqual(
      [],
    );
  });

  it('rejects a missing promptText', async () => {
    expect(await failingProps({})).toContain('promptText');
  });

  it('rejects an empty string', async () => {
    expect(await failingProps({ promptText: '' })).toContain('promptText');
  });

  it('rejects a whitespace-only string (trimmed to empty)', async () => {
    expect(await failingProps({ promptText: '   ' })).toContain('promptText');
  });

  it('rejects an over-long persona text', async () => {
    const tooLong = 'x'.repeat(PERSONA_PROMPT_MAX_LENGTH + 1);

    expect(await failingProps({ promptText: tooLong })).toContain('promptText');
  });

  it('accepts a persona at exactly the max length', async () => {
    const atMax = 'x'.repeat(PERSONA_PROMPT_MAX_LENGTH);

    expect(await failingProps({ promptText: atMax })).toEqual([]);
  });

  it('rejects a non-string promptText', async () => {
    expect(await failingProps({ promptText: 42 })).toContain('promptText');
  });
});
