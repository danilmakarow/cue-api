import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { UpdateUserSettingsDto } from './update-user-settings.dto';

/**
 * Validates a plain payload through {@link UpdateUserSettingsDto} and returns the
 * set of property names that failed validation (empty when valid).
 */
const failingProps = async (
  payload: Record<string, unknown>,
): Promise<string[]> => {
  const instance = plainToInstance(UpdateUserSettingsDto, payload);
  const errors = await validate(instance);

  return errors.map((error) => error.property);
};

describe('UpdateUserSettingsDto', () => {
  it('accepts a valid IANA timezone', async () => {
    expect(await failingProps({ timezone: 'Europe/Berlin' })).toEqual([]);
  });

  it('accepts an omitted timezone (optional)', async () => {
    expect(await failingProps({})).toEqual([]);
  });

  it('rejects an unknown timezone', async () => {
    expect(await failingProps({ timezone: 'Mars/Phobos' })).toContain(
      'timezone',
    );
  });

  it('rejects a malformed timezone string', async () => {
    expect(await failingProps({ timezone: 'not-a-zone' })).toContain(
      'timezone',
    );
  });

  it('rejects a non-string timezone', async () => {
    expect(await failingProps({ timezone: 42 })).toContain('timezone');
  });
});
