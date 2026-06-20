import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsDateString, IsOptional, IsUUID } from 'class-validator';

/**
 * Query parameters for the per-day occurrence-count read over a half-open time
 * window `[from, to)`. All dates arrive as ISO 8601 strings and are coerced to
 * `Date` in the service layer, mirroring `ListTasksQuery`.
 */
export class DailyCountsQuery {
  @ApiProperty({
    format: 'uuid',
    description: 'Calendar to count occurrences for.',
  })
  @IsUUID()
  calendarId: string;

  @ApiProperty({
    format: 'date-time',
    description: 'Inclusive window start (ISO 8601).',
    example: '2026-06-01T00:00:00.000Z',
  })
  @IsDateString()
  from: string;

  @ApiProperty({
    format: 'date-time',
    description: 'Exclusive window end (ISO 8601).',
    example: '2026-07-01T00:00:00.000Z',
  })
  @IsDateString()
  to: string;

  /**
   * When `true`, completed occurrences are counted. Defaults to `false`.
   */
  @ApiPropertyOptional({
    default: false,
    description: 'Include completed occurrences in the counts.',
  })
  @IsOptional()
  @IsBoolean()
  @Transform(
    ({ value }: { value: unknown }) => value === 'true' || value === true,
  )
  includeCompleted?: boolean;
}
