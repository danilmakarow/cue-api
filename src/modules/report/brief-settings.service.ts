import { BadRequestException, Injectable } from '@nestjs/common';
import { DateTime } from 'luxon';

import { DailyBriefCacheStore } from './daily-brief-cache.store';
import { UpdateBriefSettingsDto } from './dtos';
import { User, UserBriefSettings } from '@/modules/database/entities';
import { UserBriefSettingsDatabaseService } from '@/modules/database/services';

/**
 * Service owning the per-user daily-brief personalization settings: the
 * GET-creates-a-default read, the validated PATCH upsert of `customPrompt`, and
 * the DELETE reset. The REST controller is the sole caller; the report generator
 * reads the active custom prompt directly from the database service.
 *
 * On any write (PATCH or DELETE) it INVALIDATES today's cached brief for the user
 * (in their timezone) so a changed prompt takes effect on the next brief read
 * rather than waiting out the 24h cache. Writes go through the 3-layer `.save()`
 * path (the database service short-circuits when nothing changed).
 */
@Injectable()
export class BriefSettingsService {
  constructor(
    private readonly userBriefSettingsDatabaseService: UserBriefSettingsDatabaseService,
    private readonly dailyBriefCacheStore: DailyBriefCacheStore,
  ) {}

  /**
   * Resolves the user's CURRENT local date (`YYYY-MM-DD`, in their timezone) for
   * cache invalidation. Rejects an invalid IANA zone with 400 rather than silently
   * skipping the invalidation.
   */
  private static currentLocalDate(user: User): string {
    const today = DateTime.now().setZone(user.timezone).startOf('day');

    if (!today.isValid) {
      throw new BadRequestException(
        `User timezone "${user.timezone}" is not a valid IANA zone.`,
      );
    }

    return today.toISODate();
  }

  /**
   * Invalidates today's cached brief for the user so a settings change takes
   * effect immediately on the next brief read.
   */
  private async invalidateToday(user: User): Promise<void> {
    const localDate = BriefSettingsService.currentLocalDate(user);

    await this.dailyBriefCacheStore.invalidate(user.id, localDate);
  }

  /**
   * Returns the user's brief settings, creating a default (null `customPrompt`) on
   * the first read so the iOS Settings screen always has a row to render.
   */
  async getOrCreate(userId: string): Promise<UserBriefSettings> {
    return this.userBriefSettingsDatabaseService.findOrCreateForUser(userId);
  }

  /**
   * Applies the custom-prompt update: a non-empty string sets it, an explicit
   * null (or an empty string normalized to null by the DTO) clears it. Upserts via
   * the database service (no-op short-circuit when unchanged), then invalidates
   * today's cached brief so the new prompt takes effect immediately.
   */
  async update(
    user: User,
    dto: UpdateBriefSettingsDto,
  ): Promise<UserBriefSettings> {
    const settings =
      await this.userBriefSettingsDatabaseService.upsertCustomPromptForUser(
        user.id,
        dto.customPrompt,
      );

    await this.invalidateToday(user);

    return settings;
  }

  /**
   * Resets the user's brief settings back to the base prompt by clearing
   * `customPrompt`, then invalidates today's cached brief. Idempotent — succeeds
   * whether or not a custom prompt was set, always returning the now-cleared row.
   */
  async reset(user: User): Promise<UserBriefSettings> {
    const settings =
      await this.userBriefSettingsDatabaseService.upsertCustomPromptForUser(
        user.id,
        null,
      );

    await this.invalidateToday(user);

    return settings;
  }
}
