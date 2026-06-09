import { ApiProperty } from '@nestjs/swagger';
import { IsDateString } from 'class-validator';

/**
 * DTO for skipping a single occurrence of a recurring task.
 */
export class SkipOccurrenceDto {
  /** ISO date-time of the occurrence to skip. */
  @ApiProperty({
    format: 'date-time',
    description: 'ISO date-time of the occurrence to skip.',
    example: '2026-06-09T09:00:00.000Z',
  })
  @IsDateString()
  occurrenceStart: string;
}
