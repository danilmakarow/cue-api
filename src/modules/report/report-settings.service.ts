import { Injectable } from '@nestjs/common';

import { UpdateReportSettingsDto } from './dtos';
import { UserReportSettings } from '@/modules/database/entities';
import { UserReportSettingsDatabaseService } from '@/modules/database/services';

/**
 * Service owning the per-user daily-report settings (Story 17 / ADR 0046): the
 * GET-creates-a-default read and the validated PATCH. The REST controller is the
 * sole caller; the scheduler talks to the database service directly. Writes go
 * through the 3-layer `.save()` path, short-circuiting when nothing changed.
 */
@Injectable()
export class ReportSettingsService {
  constructor(
    private readonly userReportSettingsDatabaseService: UserReportSettingsDatabaseService,
  ) {}

  /**
   * Returns the user's report settings, creating a default (off, `08:00`) on the
   * first read so the iOS Settings screen always has a row to render.
   */
  async getOrCreate(userId: string): Promise<UserReportSettings> {
    return this.userReportSettingsDatabaseService.findOrCreateForUser(userId);
  }

  /**
   * Applies a partial update (enabled / reportTimeLocal) to the user's settings,
   * creating the default row first when none exists. Mutates only the provided
   * fields and persists via `.save()`; when the payload changes nothing, the row
   * is returned as-is without a write (the no-op short-circuit).
   */
  async update(
    userId: string,
    dto: UpdateReportSettingsDto,
  ): Promise<UserReportSettings> {
    const settings =
      await this.userReportSettingsDatabaseService.findOrCreateForUser(userId);

    let changed = false;

    if (dto.enabled !== undefined && dto.enabled !== settings.enabled) {
      settings.enabled = dto.enabled;
      changed = true;
    }

    if (
      dto.reportTimeLocal !== undefined &&
      dto.reportTimeLocal !== settings.reportTimeLocal
    ) {
      settings.reportTimeLocal = dto.reportTimeLocal;
      changed = true;
    }

    if (!changed) {
      return settings;
    }

    return this.userReportSettingsDatabaseService.save(settings);
  }
}
