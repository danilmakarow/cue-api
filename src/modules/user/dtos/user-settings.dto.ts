import { ApiProperty } from '@nestjs/swagger';

import { User } from '@/modules/database/entities';

/**
 * Response DTO for the signed-in user's mutable account settings. The iOS
 * Settings screen reads this to render (and round-trips it through PATCH).
 * `timezone` is the IANA zone every time-of-day-local computation resolves
 * against (recurrence expansion, the daily-report scheduler).
 */
export class UserSettingsDTO {
  @ApiProperty({
    description: "The user's IANA timezone identifier.",
    example: 'Europe/Berlin',
  })
  timezone: string;
}

/**
 * Maps a `User` row to its account-settings REST response shape.
 */
export const toUserSettingsDTO = (user: User): UserSettingsDTO => ({
  timezone: user.timezone,
});
