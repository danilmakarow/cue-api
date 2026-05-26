import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';

import { AppleTokenVerifier } from './apple-token.verifier';
import { AppleSignInDto } from './dtos';
import { EnvironmentVariables } from '@/config/env.config';
import { User } from '@/modules/database/entities';
import {
  CalendarDatabaseService,
  UserDatabaseService,
} from '@/modules/database/services';

/**
 * Result of a successful Apple Sign-In exchange — our JWT plus the user it maps to.
 */
export interface AuthenticationResult {
  accessToken: string;
  user: User;
}

/**
 * JWT payload signed for authenticated clients. `sub` is the Cue user UUID.
 */
export interface AccessTokenPayload {
  sub: string;
}

const DEFAULT_CALENDAR_NAME = 'Personal';
const DEFAULT_TIMEZONE = 'UTC';

/**
 * Input for `provisionUser` — the minimum set of fields the CLI / sign-in flow
 * needs to stand up a new account. `email`, `displayName`, and `timezone` are
 * optional; omitted values fall back to null / UTC.
 */
export interface ProvisionUserInput {
  appleUserId: string;
  email?: string | null;
  displayName?: string | null;
  avatarBase64?: string | null;
  timezone?: string;
}

/**
 * Handles Apple Sign-In token exchange, user provisioning, and JWT issuance.
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly appleTokenVerifier: AppleTokenVerifier,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService<EnvironmentVariables, true>,
    private readonly userDatabaseService: UserDatabaseService,
    private readonly calendarDatabaseService: CalendarDatabaseService,
  ) {}

  /**
   * Verifies an Apple identity token, creates or updates the corresponding user,
   * seeds a default calendar on first sign-in, and returns a signed JWT.
   */
  async signInWithApple(dto: AppleSignInDto): Promise<AuthenticationResult> {
    const claims = await this.appleTokenVerifier.verify(dto.identityToken);

    const existingUser = await this.userDatabaseService.findByAppleUserId(
      claims.sub,
    );

    const user = existingUser
      ? await this.updateReturningUser(existingUser, dto, claims.email)
      : await this.provisionNewUser(claims.sub, claims.email, dto);

    const accessToken = await this.issueAccessToken(user);

    return { accessToken, user };
  }

  /**
   * Loads the authenticated user by id — used by the `/auth/me` endpoint.
   * Throws 404 via `findOneByOrThrow` when the user no longer exists.
   */
  getCurrentUser(userId: string): Promise<User> {
    return this.userDatabaseService.findOneByOrThrow({ id: userId });
  }

  /**
   * Creates a new user and seeds their default calendar.
   * Used by the CLI break-glass tool; mirrors the first-sign-in branch of
   * `signInWithApple`. Throws when the `appleUserId` is already taken.
   */
  async provisionUser(input: ProvisionUserInput): Promise<User> {
    const dto: AppleSignInDto = {
      identityToken: '',
      fullName: input.displayName ?? undefined,
      avatarBase64: input.avatarBase64 ?? undefined,
      timezone: input.timezone,
    };

    return this.provisionNewUser(input.appleUserId, input.email ?? null, dto);
  }

  /**
   * Signs a JWT for an existing user — exposed for the CLI so break-glass
   * tokens go through the same signing path as sign-in.
   */
  issueTokenForUser(user: User): Promise<string> {
    return this.issueAccessToken(user);
  }

  /**
   * Provisions a new user on first sign-in and seeds their default calendar.
   */
  private async provisionNewUser(
    appleUserId: string,
    appleEmail: string | null,
    dto: AppleSignInDto,
  ): Promise<User> {
    const newUser = this.userDatabaseService.createInstance({
      appleUserId,
      email: appleEmail,
      displayName: dto.fullName ?? null,
      avatarBase64: dto.avatarBase64 ?? null,
      timezone: dto.timezone ?? DEFAULT_TIMEZONE,
    });
    const user = await this.userDatabaseService.save(newUser);

    const newCalendar = this.calendarDatabaseService.createInstance({
      ownerId: user.id,
      name: DEFAULT_CALENDAR_NAME,
      color: null,
      icon: null,
    });

    await this.calendarDatabaseService.save(newCalendar);

    return user;
  }

  /**
   * Merges newly-supplied profile details (name, avatar, timezone, email) onto
   * a returning user. Skips persistence when nothing actually changed.
   */
  private updateReturningUser(
    user: User,
    dto: AppleSignInDto,
    appleEmail: string | null,
  ): Promise<User> {
    const email = user.email ?? appleEmail;
    const displayName = dto.fullName ?? user.displayName;
    const avatarBase64 = dto.avatarBase64 ?? user.avatarBase64;
    const timezone = dto.timezone ?? user.timezone;

    const hasChanges =
      user.email !== email ||
      user.displayName !== displayName ||
      user.avatarBase64 !== avatarBase64 ||
      user.timezone !== timezone;

    if (!hasChanges) return Promise.resolve(user);

    user.email = email;
    user.displayName = displayName;
    user.avatarBase64 = avatarBase64;
    user.timezone = timezone;

    return this.userDatabaseService.save(user);
  }

  /**
   * Signs a JWT with the configured secret and TTL for the given user.
   */
  private issueAccessToken(user: User): Promise<string> {
    const payload: AccessTokenPayload = { sub: user.id };

    return this.jwtService.signAsync(payload, {
      expiresIn: this.configService.get('JWT_EXPIRES_IN', { infer: true }),
    });
  }
}
