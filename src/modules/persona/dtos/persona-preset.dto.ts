import { ApiProperty } from '@nestjs/swagger';

import { PersonaPrompt } from '@/modules/database/entities';

/**
 * Response DTO for one curated persona preset (D9). The iOS persona screen lists
 * these as pickable personas the user can adopt as a starting point. `id` lets a
 * future "apply this preset" action address a specific row; `presetName` is the
 * display label; `promptText` is the full persona instruction text previewed in
 * the editor.
 */
export class PersonaPresetDTO {
  @ApiProperty({ description: 'Stable id of the preset row.', format: 'uuid' })
  id: string;

  @ApiProperty({
    description: 'Display name of the preset.',
    example: 'Jarvis',
  })
  presetName: string;

  @ApiProperty({ description: 'The full persona instruction text.' })
  promptText: string;
}

/**
 * Maps a curated `PRESET` {@link PersonaPrompt} row to its REST list shape (D9).
 */
export const toPersonaPresetDTO = (
  preset: PersonaPrompt,
): PersonaPresetDTO => ({
  id: preset.id,
  presetName: preset.presetName ?? '',
  promptText: preset.promptText,
});
