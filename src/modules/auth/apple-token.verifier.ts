import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtHeader, SigningKeyCallback, verify } from 'jsonwebtoken';
import { JwksClient } from 'jwks-rsa';

import { EnvironmentVariables } from '@/config/env.config';

const APPLE_ISSUER = 'https://appleid.apple.com';
const APPLE_JWKS_URI = 'https://appleid.apple.com/auth/keys';

/**
 * Verified identity claims pulled from a valid Apple `identityToken`.
 */
export interface AppleIdentityClaims {
  sub: string;
  email: string | null;
  emailVerified: boolean;
}

/**
 * Verifies Apple Sign-In identity tokens using Apple's published JWK set,
 * checking the signature, issuer, audience, and expiry.
 */
@Injectable()
export class AppleTokenVerifier {
  private readonly logger = new Logger(AppleTokenVerifier.name);

  private readonly jwks: JwksClient;

  private readonly audience: string;

  constructor(configService: ConfigService<EnvironmentVariables, true>) {
    this.audience = configService.get('APPLE_CLIENT_ID', { infer: true });
    this.jwks = new JwksClient({
      jwksUri: APPLE_JWKS_URI,
      cache: true,
      cacheMaxEntries: 5,
      cacheMaxAge: 10 * 60 * 1000,
      rateLimit: true,
    });
  }

  /**
   * Resolves the PEM signing key for a given JWT header via Apple's JWKS.
   */
  private getSigningKey(header: JwtHeader, callback: SigningKeyCallback): void {
    if (!header.kid) {
      callback(new Error('Missing key id on Apple identity token header'));

      return;
    }

    this.jwks
      .getSigningKey(header.kid)
      .then((key) => callback(null, key.getPublicKey()))
      .catch((error: Error) => callback(error));
  }

  /**
   * Verifies an Apple identity token and returns the authenticated claims.
   * Throws `UnauthorizedException` on any validation failure.
   */
  async verify(identityToken: string): Promise<AppleIdentityClaims> {
    return new Promise<AppleIdentityClaims>((resolve, reject) => {
      verify(
        identityToken,
        (header: JwtHeader, callback: SigningKeyCallback) =>
          this.getSigningKey(header, callback),
        {
          algorithms: ['RS256'],
          audience: this.audience,
          issuer: APPLE_ISSUER,
        },
        (error, payload) => {
          if (error || !payload || typeof payload === 'string') {
            this.logger.warn(
              `Apple identity token rejected: ${error?.message ?? 'invalid payload'}`,
            );
            reject(new UnauthorizedException('Invalid Apple identity token'));

            return;
          }

          const sub = typeof payload.sub === 'string' ? payload.sub : null;

          if (!sub) {
            reject(new UnauthorizedException('Apple token missing sub claim'));

            return;
          }

          const rawEmail = (payload as { email?: unknown }).email;
          const rawEmailVerified = (payload as { email_verified?: unknown })
            .email_verified;

          resolve({
            sub,
            email: typeof rawEmail === 'string' ? rawEmail : null,
            emailVerified:
              rawEmailVerified === true || rawEmailVerified === 'true',
          });
        },
      );
    });
  }
}
