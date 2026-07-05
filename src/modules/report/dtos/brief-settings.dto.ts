import { ApiProperty } from '@nestjs/swagger';

import { UserBriefSettings } from '@/modules/database/entities';

/**
 * Response DTO for the user's daily-brief personalization settings. The iOS
 * Settings screen reads this to render the custom-prompt editor. `customPrompt`
 * is the user's own instruction appended to the base daily-brief system prompt,
 * or null when unset (the base prompt is used as-is).
 */
export class BriefSettingsDTO {
  @ApiProperty({
    description:
      'The user custom instruction appended to the base daily-brief prompt, ' +
      'or null when unset (the base prompt is used as-is).',
    type: String,
    nullable: true,
    example: 'Keep it very brief and mention the weather if relevant.',
  })
  customPrompt: string | null;
}

/**
 * Maps a persisted `UserBriefSettings` row to its REST response shape.
 */
export const toBriefSettingsDTO = (
  settings: UserBriefSettings,
): BriefSettingsDTO => ({
  customPrompt: settings.customPrompt,
});
