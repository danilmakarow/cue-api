import { Transform } from 'class-transformer';
import { IsBoolean, IsDateString, IsOptional, IsUUID } from 'class-validator';

/**
 * Query parameters for listing Task occurrences in a half-open time window
 * `[from, to)`. All dates arrive as ISO 8601 strings and are coerced to `Date`
 * in the service layer.
 */
export class ListTasksQuery {
  @IsUUID()
  calendarId: string;

  @IsDateString()
  from: string;

  @IsDateString()
  to: string;

  /**
   * When `true`, completed occurrences are included in the response.
   * Defaults to `false`.
   */
  @IsOptional()
  @IsBoolean()
  @Transform(
    ({ value }: { value: unknown }) => value === 'true' || value === true,
  )
  includeCompleted?: boolean;

  /**
   * When `true`, timeless todos (no `startAt`) are included.
   * Defaults to `false`.
   */
  @IsOptional()
  @IsBoolean()
  @Transform(
    ({ value }: { value: unknown }) => value === 'true' || value === true,
  )
  includeTodos?: boolean;
}
