import { IsBoolean, IsDateString, IsOptional } from 'class-validator';

/**
 * DTO for toggling completion of a task or a single occurrence of a recurring
 * task. When `occurrenceStart` is provided, only the identified occurrence is
 * toggled; otherwise the series anchor (or one-off task) is toggled.
 */
export class SetCompletionDto {
  @IsBoolean()
  isCompleted: boolean;

  /**
   * ISO date-time identifying the occurrence to toggle. Required for per-instance
   * completion of a recurring task; omitted for one-offs or series-wide completion.
   */
  @IsOptional()
  @IsDateString()
  occurrenceStart?: string;
}
