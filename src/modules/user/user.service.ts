import { Injectable } from '@nestjs/common';

import { UpdateUserSettingsDto } from './dtos';
import { AppleTokenRevoker } from '@/modules/auth/apple-token.revoker';
import { User } from '@/modules/database/entities';
import { UserDatabaseService } from '@/modules/database/services';

/**
 * Service handling business logic for user management.
 */
@Injectable()
export class UserService {
  constructor(
    private readonly userDatabaseService: UserDatabaseService,
    private readonly appleTokenRevoker: AppleTokenRevoker,
  ) {}

  /**
   * Applies a partial update to the signed-in user's mutable account settings —
   * `timezone` (validated as a real IANA zone by the DTO), `displayName`
   * (trimmed + bounded), `avatarBase64` (size/format validated), and the
   * `morningBriefEnabled` / `eveningRecapEnabled` notification opt-ins. Loads the
   * user, mutates only the provided fields, and persists via `.save()`; when the
   * payload changes nothing, the row is returned as-is without a write.
   */
  async updateSettings(
    userId: string,
    dto: UpdateUserSettingsDto,
  ): Promise<User> {
    const user = await this.userDatabaseService.findOneByOrThrow({
      id: userId,
    });

    let changed = false;

    if (dto.timezone !== undefined && dto.timezone !== user.timezone) {
      user.timezone = dto.timezone;
      changed = true;
    }

    if (dto.displayName !== undefined && dto.displayName !== user.displayName) {
      user.displayName = dto.displayName;
      changed = true;
    }

    if (
      dto.avatarBase64 !== undefined &&
      dto.avatarBase64 !== user.avatarBase64
    ) {
      user.avatarBase64 = dto.avatarBase64;
      changed = true;
    }

    if (
      dto.morningBriefEnabled !== undefined &&
      dto.morningBriefEnabled !== user.morningBriefEnabled
    ) {
      user.morningBriefEnabled = dto.morningBriefEnabled;
      changed = true;
    }

    if (
      dto.eveningRecapEnabled !== undefined &&
      dto.eveningRecapEnabled !== user.eveningRecapEnabled
    ) {
      user.eveningRecapEnabled = dto.eveningRecapEnabled;
      changed = true;
    }

    if (!changed) {
      return user;
    }

    return this.userDatabaseService.save(user);
  }

  /**
   * Permanently deletes the signed-in user's account. First revokes the user's
   * Apple refresh token (Sign-in-with-Apple account-deletion policy; best-effort,
   * never blocks the purge), then deletes the `user` row — the DB-level FK
   * cascades take down the whole aggregate (Calendars → Tasks/Groups/Strategies,
   * Devices, TelegramLink, ScheduledNotifications, PersonaPrompt,
   * UserReportSettings). Throws 404 when the user no longer exists.
   */
  async deleteAccount(userId: string): Promise<void> {
    const user = await this.userDatabaseService.findOneByOrThrow({
      id: userId,
    });

    // Cue does not persist an Apple refresh token yet (see needsWiring); pass it
    // through so the revocation call is wired and starts working the moment that
    // column lands, while degrading to a logged no-op until then. The revoker is
    // the auth module's Apple-revocation slice (also exposed via
    // `AuthService.revokeAppleToken`); it never throws, so a misconfigured or
    // unreachable Apple endpoint cannot block the local aggregate purge.
    await this.appleTokenRevoker.revokeRefreshToken(null);

    await this.userDatabaseService.deleteOrThrow(user.id);
  }
}
