import { ApiProperty } from '@nestjs/swagger';

import {
  NotificationChannel,
  UserReportSettings,
} from '@/modules/database/entities';

/**
 * Response DTO for the user's daily-report settings (Story 17 / ADR 0046). The
 * iOS Settings screen reads this to render the report toggle + time picker. Only
 * the user-facing fields are surfaced; `lastSentLocalDate` is an internal
 * idempotency detail and is deliberately not exposed.
 */
export class ReportSettingsDTO {
  @ApiProperty({ description: 'Whether the daily report is switched on.' })
  enabled: boolean;

  @ApiProperty({
    description:
      'Local wall-clock send time as `HH:mm` (24-hour), interpreted in the user timezone.',
    example: '08:00',
  })
  reportTimeLocal: string;

  @ApiProperty({
    description:
      'Preferred delivery channel for the daily report. NOTE: push delivery is ' +
      'deferred (D1) — a `PUSH` value persists but only Telegram delivers today, ' +
      'so the report is sent over Telegram regardless until the push pipeline ships.',
    enum: NotificationChannel,
    example: NotificationChannel.TELEGRAM,
  })
  channel: NotificationChannel;
}

/**
 * Maps a persisted `UserReportSettings` row to its REST response shape.
 */
export const toReportSettingsDTO = (
  settings: UserReportSettings,
): ReportSettingsDTO => ({
  enabled: settings.enabled,
  reportTimeLocal: settings.reportTimeLocal,
  channel: settings.channel,
});
