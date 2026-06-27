import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Body of `POST /assistant/parse` (D4) — one line of natural language the iOS
 * quick-create well sends to be turned into a structured task draft WITHOUT
 * creating anything. Bounded so a stray paste can't drive an unbounded model
 * call; the model extracts a title, an optional time, duration, recurrence, and
 * group from this text.
 */
export class ParseTaskDto {
  @ApiProperty({
    description:
      'A single line of natural language describing a task to draft, e.g. "lunch with Sam tomorrow at 1pm for an hour".',
    example: 'gym every monday and wednesday at 7am',
    minLength: 1,
    maxLength: 500,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  text: string;
}
