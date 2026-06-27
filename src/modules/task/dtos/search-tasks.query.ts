import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';

/**
 * Default number of matches returned by the task search when no `limit` is given.
 */
export const SEARCH_DEFAULT_LIMIT = 25;

/**
 * Maximum number of matches the task search will ever return, clamping `limit`.
 */
export const SEARCH_MAX_LIMIT = 50;

/**
 * Query parameters for the case-insensitive task text search (M1). Scoped to the
 * authed user's tasks across ALL their calendars (NOT window-bound); an optional
 * `groupId` narrows to a single group, and `limit` caps the result count.
 */
export class SearchTasksQuery {
  @ApiProperty({
    example: 'dentist',
    description: 'Case-insensitive search term matched against title + notes.',
  })
  @IsString()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  q: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Narrow the search to a single task group.',
  })
  @IsOptional()
  @IsUUID()
  groupId?: string;

  @ApiPropertyOptional({
    default: SEARCH_DEFAULT_LIMIT,
    maximum: SEARCH_MAX_LIMIT,
    description: 'Maximum matches to return (clamped).',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === undefined ? undefined : Number(value),
  )
  @IsInt()
  @Min(1)
  @Max(SEARCH_MAX_LIMIT)
  limit?: number;
}
