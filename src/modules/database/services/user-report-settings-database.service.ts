import { Injectable } from '@nestjs/common';

import { UserReportSettings } from '@/modules/database/entities';
import { UserReportSettingsRepository } from '@/modules/database/repositories';
import { BaseDatabaseService } from '@/modules/database/services/base-database.service';

/**
 * Database service for the UserReportSettings entity (Story 17 / ADR 0046) — the
 * per-user daily-report opt-in, send time, and last-sent-date idempotency guard.
 */
@Injectable()
export class UserReportSettingsDatabaseService extends BaseDatabaseService<UserReportSettings> {
  constructor(userReportSettingsRepository: UserReportSettingsRepository) {
    super(userReportSettingsRepository);
  }

  /**
   * Finds the report settings row for the given user, or null when none exists.
   * The REST GET path lazily creates a default row on the first read.
   */
  findByUserId(userId: string): Promise<UserReportSettings | null> {
    return this.findOneBy({ userId });
  }

  /**
   * Returns the settings row for a user, creating and persisting a default
   * (off, `08:00`, never sent) when none exists — the GET-creates-a-default
   * contract. Idempotent on the unique `userId`.
   */
  async findOrCreateForUser(userId: string): Promise<UserReportSettings> {
    const existing = await this.findByUserId(userId);

    if (existing) {
      return existing;
    }

    const created = this.createInstance({ userId });

    return this.save(created);
  }

  /**
   * Returns every opted-in (`enabled = true`) settings row — the candidate set
   * the per-minute scheduler scans. Cheap thanks to the `enabled` index; the
   * per-user timezone/time match happens in memory afterwards.
   */
  findAllEnabled(): Promise<UserReportSettings[]> {
    return this.findAll({ where: { enabled: true } });
  }
}
