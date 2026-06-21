import { ApiProperty } from '@nestjs/swagger';

import {
  PersonaPrompt,
  PersonaPromptSource,
} from '@/modules/database/entities';

/**
 * Response DTO for the user's AI persona settings (Story 18 / ADR 0014). The iOS
 * Settings screen reads this to render the persona editor. `promptText` is the
 * active persona (the user's own when set, else the seeded "Jarvis" preset);
 * `source` tells the screen whether it is showing a curated preset or the user's
 * own custom text; `presetName` is the preset's display name when applicable.
 */
export class PersonaSettingsDTO {
  @ApiProperty({
    description: 'The active persona instruction text the assistant adopts.',
  })
  promptText: string;

  @ApiProperty({
    description:
      'Whether the active persona is a curated preset or the user own custom text.',
    enum: PersonaPromptSource,
  })
  source: PersonaPromptSource;

  @ApiProperty({
    description: 'Display name when the active persona is a preset, else null.',
    nullable: true,
    example: 'Jarvis',
  })
  presetName: string | null;
}

/**
 * Maps a resolved `PersonaPrompt` row (the user's own `CUSTOM` persona or the
 * seeded fallback `PRESET`) to its REST response shape.
 */
export const toPersonaSettingsDTO = (
  persona: PersonaPrompt,
): PersonaSettingsDTO => ({
  promptText: persona.promptText,
  source: persona.source,
  presetName: persona.presetName,
});
