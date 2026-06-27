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

  it('accepts and trims a valid displayName', async () => {
    const instance = plainToInstance(UpdateUserSettingsDto, {
      displayName: '  Jane Appleseed  ',
    });

    expect(await validate(instance)).toEqual([]);
    expect(instance.displayName).toBe('Jane Appleseed');
  });

  it('rejects a whitespace-only displayName (trims to empty)', async () => {
    expect(await failingProps({ displayName: '   ' })).toContain('displayName');
  });

  it('rejects an over-long displayName', async () => {
    expect(await failingProps({ displayName: 'a'.repeat(201) })).toContain(
      'displayName',
    );
  });

  it('accepts a valid base64 avatar', async () => {
    expect(await failingProps({ avatarBase64: 'aGVsbG8=' })).toEqual([]);
  });

  it('rejects a non-base64 avatar', async () => {
    expect(await failingProps({ avatarBase64: 'not base64 !!!' })).toContain(
      'avatarBase64',
    );
  });

  it('accepts the boolean notification prefs', async () => {
    expect(
      await failingProps({
        morningBriefEnabled: true,
        eveningRecapEnabled: false,
      }),
    ).toEqual([]);
  });

  it('rejects a non-boolean notification pref', async () => {
    expect(await failingProps({ morningBriefEnabled: 'yes' })).toContain(
      'morningBriefEnabled',
    );
  });
});
