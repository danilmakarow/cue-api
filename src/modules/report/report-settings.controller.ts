import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import {
  ReportSettingsDTO,
  UpdateReportSettingsDto,
  toReportSettingsDTO,
} from './dtos';
import { ReportSettingsService } from './report-settings.service';
import { CurrentUser } from '@/decorators/current-user.decorator';
import { AccessTokenGuard } from '@/guards/access-token.guard';
import { User } from '@/modules/database/entities';
import { Swagger } from '@/modules/swagger/decorators/swagger.decorator';

/**
 * Controller exposing the per-user daily-report settings (Story 17 / ADR 0046)
 * the iOS Settings screen reads and writes. Telegram exposes NO config — these
 * settings are REST/iOS only. All routes require a valid JWT via
 * `AccessTokenGuard` and operate on the current user (`/users/me/...`).
 */
@ApiTags('Users')
@UseGuards(AccessTokenGuard)
@Controller('users/me/report-settings')
export class ReportSettingsController {
  constructor(private readonly reportSettingsService: ReportSettingsService) {}

  /**
   * Returns the current user's daily-report settings, creating a default
   * (off, `08:00`) on the first read.
   */
  @Get()
  @Swagger({
    summary: 'Get the current user daily-report settings (creates a default).',
    responseDto: ReportSettingsDTO,
    responseStatus: 200,
  })
  async get(@CurrentUser() user: User): Promise<ReportSettingsDTO> {
    const settings = await this.reportSettingsService.getOrCreate(user.id);

    return toReportSettingsDTO(settings);
  }

  /**
   * Updates the current user's daily-report settings (enabled / reportTimeLocal),
   * validating `reportTimeLocal` as a 24-hour `HH:mm`. Returns the persisted shape.
   */
  @Patch()
  @Swagger({
    summary: 'Update the current user daily-report settings.',
    responseDto: ReportSettingsDTO,
    responseStatus: 200,
  })
  async update(
    @CurrentUser() user: User,
    @Body() dto: UpdateReportSettingsDto,
  ): Promise<ReportSettingsDTO> {
    const settings = await this.reportSettingsService.update(user.id, dto);

    return toReportSettingsDTO(settings);
  }
}
