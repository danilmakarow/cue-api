import { IsDateString } from 'class-validator';

/**
 * DTO for skipping a single occurrence of a recurring task.
 */
export class SkipOccurrenceDto {
  /** ISO date-time of the occurrence to skip. */
  @IsDateString()
  occurrenceStart: string;
}
