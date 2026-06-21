import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';

/** Minimum length of a custom persona prompt (a non-empty, trimmed string). */
export const PERSONA_PROMPT_MIN_LENGTH = 1;

/**
 * Maximum length of a custom persona prompt. Bounded so a user cannot inflate the
 * per-user cached region (ADR 0004) without limit; comfortably fits a rich
 * persona while keeping the breakpoint-#2 region small.
 */
export const PERSONA_PROMPT_MAX_LENGTH = 2000;

/**
 * DTO for PATCH `/users/me/persona-settings` (Story 18 / ADR 0014). The single
 * `promptText` is the user's own persona; it is required, trimmed, and bounded —
 * an empty (whitespace-only) or over-long value is rejected with 400 rather than
 * stored, since it is injected verbatim into the per-user prompt region.
 */
export class UpdatePersonaSettingsDto {
  @ApiProperty({
    description: 'The custom persona instruction text for the assistant.',
    minLength: PERSONA_PROMPT_MIN_LENGTH,
    maxLength: PERSONA_PROMPT_MAX_LENGTH,
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(PERSONA_PROMPT_MIN_LENGTH, {
    message: 'promptText must not be empty.',
  })
  @MaxLength(PERSONA_PROMPT_MAX_LENGTH, {
    message: `promptText must be at most ${PERSONA_PROMPT_MAX_LENGTH} characters.`,
  })
  promptText: string;
}
