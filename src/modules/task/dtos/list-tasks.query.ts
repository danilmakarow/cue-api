import { IsDateString, IsUUID } from 'class-validator';

/**
 * Query parameters for listing Tasks inside a Calendar within a half-open
 * time window `[from, to)`. Dates arrive as ISO 8601 strings and are coerced
 * to `Date` in the service layer.
 */
export class ListTasksQuery {
  @IsUUID()
  calendarId: string;

  @IsDateString()
  from: string;

  @IsDateString()
  to: string;
}
