import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, MaxLength, ValidateIf } from 'class-validator';

/**
 * Maximum length of a custom brief prompt. Bounded so a user cannot inflate the
 * per-generation prompt without limit; comfortably fits a rich instruction while
 * keeping the MAIN-model input small.
 */
export const BRIEF_CUSTOM_PROMPT_MAX_LENGTH = 2000;

/**
 * DTO for PATCH `/users/me/brief-settings`. The single `customPrompt` is the
 * user's own instruction appended to the base daily-brief prompt. It is REQUIRED
 * in the body but nullable: a non-empty string (trimmed, length-bounded) sets it;
 * an explicit `null` clears it back to the base prompt. An empty / whitespace-only
 * string is normalized to `null` (a clear) rather than stored, since it would add
 * nothing to the prompt.
 */
export class UpdateBriefSettingsDto {
  @ApiProperty({
    description:
      'The custom instruction appended to the base daily-brief prompt. A non-' +
      'empty string sets it; null (or an empty string) clears it back to the ' +
      'base prompt.',
    type: String,
    nullable: true,
    required: true,
    maxLength: BRIEF_CUSTOM_PROMPT_MAX_LENGTH,
    example: 'Keep it very brief and mention the weather if relevant.',
  })
  @Transform(({ value }: { value: unknown }) => {
    if (typeof value !== 'string') {
      return value;
    }

    const trimmed = value.trim();

    return trimmed.length === 0 ? null : trimmed;
  })
  @ValidateIf(
    (_object: UpdateBriefSettingsDto, value: unknown) => value !== null,
  )
  @IsString()
  @MaxLength(BRIEF_CUSTOM_PROMPT_MAX_LENGTH, {
    message: `customPrompt must be at most ${BRIEF_CUSTOM_PROMPT_MAX_LENGTH} characters.`,
  })
  customPrompt: string | null;
}
