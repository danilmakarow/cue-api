import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { sign } from 'jsonwebtoken';

import { EnvironmentVariables } from '@/config/env.config';

const APPLE_ISSUER = 'https://appleid.apple.com';
const APPLE_REVOKE_URI = 'https://appleid.apple.com/auth/revoke';

/**
 * The Sign-in-with-Apple secrets needed to mint the client-secret JWT and call
 * the token-revocation endpoint. `clientId` (the Services/app id) is already in
 * the env schema as `APPLE_CLIENT_ID`; the remaining three are NOT yet in the
 * Zod schema (see `needsWiring`) and are read defensively from `process.env`, so
 * revocation degrades to a logged no-op rather than crashing account deletion
 * when Apple is unconfigured.
 */
interface AppleRevocationConfig {
  clientId: string;
  teamId: string;
  keyId: string;
  privateKey: string;
}

/**
 * Calls Apple's token-revocation endpoint when a user deletes their account, as
 * required by the Sign-in-with-Apple account-deletion policy. Builds the
 * short-lived ES256 client-secret JWT Apple requires, then revokes the user's
 * stored refresh token. Best-effort by contract: a missing config or an Apple
 * error is logged and swallowed so it never blocks the local aggregate purge.
 */
@Injectable()
export class AppleTokenRevoker {
  private readonly logger = new Logger(AppleTokenRevoker.name);

  constructor(
    private readonly configService: ConfigService<EnvironmentVariables, true>,
  ) {}

  /**
   * Resolves the revocation config, or null when any required secret is absent.
   * `APPLE_CLIENT_ID` comes from the typed schema; the signing-key trio is read
   * from `process.env` because those keys are not in the Zod schema yet.
   */
  private resolveConfig(): AppleRevocationConfig | null {
    const clientId = this.configService.get('APPLE_CLIENT_ID', { infer: true });
    const teamId = process.env.APPLE_TEAM_ID;
    const keyId = process.env.APPLE_KEY_ID;
    // PEM private key; literal "\n" sequences are normalized to real newlines so
    // the key can live on a single SSM/.env line.
    const privateKey = process.env.APPLE_PRIVATE_KEY?.replace(/\\n/g, '\n');

    if (!clientId || !teamId || !keyId || !privateKey) {
      return null;
    }

    return { clientId, teamId, keyId, privateKey };
  }

  /**
   * Mints the ES256 client-secret JWT Apple requires for server-to-server calls:
   * issued by the team, scoped to Apple as audience, subject = the client id, and
   * short-lived (10 minutes, well under Apple's 6-month ceiling).
   */
  private buildClientSecret(config: AppleRevocationConfig): string {
    const nowSeconds = Math.floor(Date.now() / 1000);

    return sign(
      {
        iss: config.teamId,
        iat: nowSeconds,
        exp: nowSeconds + 10 * 60,
        aud: APPLE_ISSUER,
        sub: config.clientId,
      },
      config.privateKey,
      { algorithm: 'ES256', keyid: config.keyId },
    );
  }

  /**
   * Revokes the given Apple refresh token for the user being deleted. No-ops
   * (with a warning) when Apple is unconfigured or no refresh token was stored,
   * and never throws — revocation is best-effort relative to the local purge.
   */
  async revokeRefreshToken(refreshToken: string | null): Promise<void> {
    if (!refreshToken) {
      this.logger.warn(
        'Skipping Apple token revocation: no stored refresh token for the deleted user.',
      );

      return;
    }

    const config = this.resolveConfig();

    if (!config) {
      this.logger.warn(
        'Skipping Apple token revocation: Apple client config is incomplete ' +
          '(needs APPLE_CLIENT_ID, APPLE_TEAM_ID, APPLE_KEY_ID, APPLE_PRIVATE_KEY).',
      );

      return;
    }

    try {
      const clientSecret = this.buildClientSecret(config);
      const body = new URLSearchParams({
        client_id: config.clientId,
        client_secret: clientSecret,
        token: refreshToken,
        token_type_hint: 'refresh_token',
      });

      const response = await fetch(APPLE_REVOKE_URI, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });

      if (!response.ok) {
        const detail = await response.text();

        this.logger.warn(
          `Apple token revocation returned ${response.status}: ${detail}`,
        );

        return;
      }

      this.logger.log('Apple refresh token revoked for deleted user.');
    } catch (error) {
      this.logger.warn(
        `Apple token revocation failed: ${(error as Error).message}`,
      );
    }
  }
}
