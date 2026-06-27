import { ConfigService } from '@nestjs/config';

import { AppleTokenRevoker } from './apple-token.revoker';
import { EnvironmentVariables } from '@/config/env.config';

// An ES256 private key (P-256) used only to exercise the client-secret signing
// path — it is a throwaway test key, not a real Apple key.
const TEST_ES256_PRIVATE_KEY = [
  '-----BEGIN PRIVATE KEY-----',
  'MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgpsWrCA1lrgoVlOO/',
  '3Oz9mX9JR2TzBubMUDYoAJcuvq+hRANCAAT/oVRrJAEr0cOOSeR8/gDwAvTO56qe',
  '6kpHqPVNXdJLShLCxmZgAZ+4i2xrBI+PSDJIfW9FbJkz95rbQAUXuJdu',
  '-----END PRIVATE KEY-----',
].join('\n');

/**
 * Builds an {@link AppleTokenRevoker} whose `ConfigService.get` returns the given
 * `APPLE_CLIENT_ID`. The signing-key trio is read from `process.env`, so each
 * test sets/clears those directly.
 */
const buildRevoker = (clientId: string | undefined) => {
  const configService = {
    get: jest.fn().mockReturnValue(clientId),
  } as unknown as ConfigService<EnvironmentVariables, true>;

  return new AppleTokenRevoker(configService);
};

describe('AppleTokenRevoker.revokeRefreshToken', () => {
  const originalEnv = { ...process.env };
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn().mockResolvedValue({ ok: true, text: async () => '' });
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
  });

  it('no-ops (no fetch) when the refresh token is null', async () => {
    const revoker = buildRevoker('com.cue.app');

    await revoker.revokeRefreshToken(null);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('no-ops (no fetch) when Apple config is incomplete', async () => {
    delete process.env.APPLE_TEAM_ID;
    delete process.env.APPLE_KEY_ID;
    delete process.env.APPLE_PRIVATE_KEY;

    const revoker = buildRevoker('com.cue.app');

    await revoker.revokeRefreshToken('refresh-token');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POSTs to Apple revoke with a signed client secret when fully configured', async () => {
    process.env.APPLE_TEAM_ID = 'TEAM123456';
    process.env.APPLE_KEY_ID = 'KEY1234567';
    process.env.APPLE_PRIVATE_KEY = TEST_ES256_PRIVATE_KEY;

    const revoker = buildRevoker('com.cue.app');

    await revoker.revokeRefreshToken('refresh-token');

    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];

    expect(url).toBe('https://appleid.apple.com/auth/revoke');
    expect(init.method).toBe('POST');

    const params = new URLSearchParams(init.body as string);

    expect(params.get('client_id')).toBe('com.cue.app');
    expect(params.get('token')).toBe('refresh-token');
    expect(params.get('token_type_hint')).toBe('refresh_token');
    expect(params.get('client_secret')).toBeTruthy();
  });

  it('swallows a non-OK Apple response (never throws)', async () => {
    process.env.APPLE_TEAM_ID = 'TEAM123456';
    process.env.APPLE_KEY_ID = 'KEY1234567';
    process.env.APPLE_PRIVATE_KEY = TEST_ES256_PRIVATE_KEY;
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => 'invalid_grant',
    });

    const revoker = buildRevoker('com.cue.app');

    await expect(
      revoker.revokeRefreshToken('refresh-token'),
    ).resolves.toBeUndefined();
  });
});
