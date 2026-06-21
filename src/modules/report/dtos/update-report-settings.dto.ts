import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, Matches } from 'class-validator';

/** Validates a 24-hour zero-padded `HH:mm` wall-clock string (`00:00`–`23:59`). */
export const REPORT_TIME_LOCAL_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * DTO for PATCH `/users/me/report-settings` (Story 17 / ADR 0046). Both fields
 * are optional — the client sends only what changed. `reportTimeLocal` must be a
 * valid 24-hour `HH:mm`; an out-of-range or malformed value is rejected with 400
 * rather than silently stored, since the scheduler matches on it to the minute.
 */
export class UpdateReportSettingsDto {
  @ApiPropertyOptional({ description: 'Switch the daily report on or off.' })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({
    description:
      'Local wall-clock send time as `HH:mm` (24-hour, zero-padded).',
    example: '08:00',
  })
  @IsOptional()
  @Matches(REPORT_TIME_LOCAL_PATTERN, {
    message: 'reportTimeLocal must be a 24-hour HH:mm time (e.g. 08:00).',
  })
  reportTimeLocal?: string;
}
