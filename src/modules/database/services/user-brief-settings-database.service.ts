import { Injectable } from '@nestjs/common';

import { UserBriefSettings } from '@/modules/database/entities';
import { UserBriefSettingsRepository } from '@/modules/database/repositories';
import { BaseDatabaseService } from '@/modules/database/services/base-database.service';

/**
 * Database service for the UserBriefSettings entity — the per-user daily-brief
 * personalization (`customPrompt`). A user's row is created lazily on first read
 * and holds a nullable custom prompt that AUGMENTS the base daily-brief system
 * prompt. Writes go through the 3-layer `.save()` path with a no-op short-circuit
 * when the value is unchanged.
 */
@Injectable()
export class UserBriefSettingsDatabaseService extends BaseDatabaseService<UserBriefSettings> {
  constructor(userBriefSettingsRepository: UserBriefSettingsRepository) {
    super(userBriefSettingsRepository);
  }

  /**
   * Finds the brief-settings row for the given user, or null when none exists.
   * The REST GET path lazily creates a default (null `customPrompt`) row.
   */
  findByUserId(userId: string): Promise<UserBriefSettings | null> {
    return this.findOneBy({ userId });
  }

  /**
   * Returns the brief-settings row for a user, creating and persisting a default
   * (null `customPrompt`) when none exists — the GET-creates-a-default contract.
   * Idempotent on the unique `userId`.
   */
  async findOrCreateForUser(userId: string): Promise<UserBriefSettings> {
    const existing = await this.findByUserId(userId);

    if (existing) {
      return existing;
    }

    const created = this.createInstance({ userId, customPrompt: null });

    return this.save(created);
  }

  /**
   * Upserts a user's `customPrompt` (a non-empty string to set it, or null to
   * clear it back to the base prompt), returning the persisted row. Mutates the
   * existing row in place (no-op short-circuit when unchanged) or creates a fresh
   * one, always through `.save()` per the 3-layer write rule.
   */
  async upsertCustomPromptForUser(
    userId: string,
    customPrompt: string | null,
  ): Promise<UserBriefSettings> {
    const existing = await this.findByUserId(userId);

    if (existing) {
      if (existing.customPrompt === customPrompt) {
        return existing;
      }

      existing.customPrompt = customPrompt;

      return this.save(existing);
    }

    const created = this.createInstance({ userId, customPrompt });

    return this.save(created);
  }

  /**
   * Resolves the user's active `customPrompt` for the brief generator: the stored
   * value when a row exists, else null (no row yet). One read on the hot path; the
   * generator treats null / empty as "use the base prompt as-is".
   */
  async findCustomPromptForUser(userId: string): Promise<string | null> {
    const existing = await this.findByUserId(userId);

    return existing ? existing.customPrompt : null;
  }
}
