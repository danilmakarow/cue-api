import { ApiProperty } from '@nestjs/swagger';

import { User } from '@/modules/database/entities';

/**
 * Response DTO for the signed-in user's mutable account settings. The iOS
 * Settings screen reads this to render (and round-trips it through PATCH).
 * `timezone` is the IANA zone every time-of-day-local computation resolves
 * against (recurrence expansion, the daily-report scheduler); `displayName` and
 * `avatarBase64` are now editable post sign-in; `morningBriefEnabled` /
 * `eveningRecapEnabled` are the cross-device notification opt-ins (D8).
 */
export class UserSettingsDTO {
  @ApiProperty({
    description: "The user's IANA timezone identifier.",
    example: 'Europe/Berlin',
  })
  timezone: string;

  @ApiProperty({
    nullable: true,
    description: "The user's display name.",
    example: 'Jane Appleseed',
  })
  displayName: string | null;

  @ApiProperty({
    nullable: true,
    description: 'Base64-encoded profile picture (no data-URL prefix).',
  })
  avatarBase64: string | null;

  @ApiProperty({
    description: 'Whether the morning-brief notification is enabled.',
    example: true,
  })
  morningBriefEnabled: boolean;

  @ApiProperty({
    description: 'Whether the evening-recap notification is enabled.',
    example: true,
  })
  eveningRecapEnabled: boolean;
}

/**
 * Maps a `User` row to its account-settings REST response shape.
 */
export const toUserSettingsDTO = (user: User): UserSettingsDTO => ({
  timezone: user.timezone,
  displayName: user.displayName,
  avatarBase64: user.avatarBase64,
  morningBriefEnabled: user.morningBriefEnabled,
  eveningRecapEnabled: user.eveningRecapEnabled,
});
