import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, Matches } from 'class-validator';

/** Validates a zero-padded ISO local date `YYYY-MM-DD`. */
export const DAILY_BRIEF_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Query parameters for GET `/users/me/daily-brief` (backlog D2). `date` is an
 * optional local `YYYY-MM-DD` interpreted in the user's timezone; when omitted
 * the brief covers the user's CURRENT local day. The strict `YYYY-MM-DD` shape is
 * enforced here so a malformed value is rejected with 400 before the service
 * spends a MAIN-model call. `refresh`, when true, BYPASSES the cache read,
 * regenerates, and OVERWRITES the cached value — used after the user changes
 * their brief settings, or to force a fresh brief on demand.
 */
export class DailyBriefQuery {
  @ApiPropertyOptional({
    description:
      'Local date `YYYY-MM-DD` (user timezone) to brief on; defaults to today.',
    example: '2026-06-27',
  })
  @IsOptional()
  @Matches(DAILY_BRIEF_DATE_PATTERN, {
    message: 'date must be an ISO local date (YYYY-MM-DD).',
  })
  date?: string;

  @ApiPropertyOptional({
    description:
      'When true, bypass the cache read, regenerate, and overwrite the cached ' +
      'brief. Defaults to false.',
    type: Boolean,
    example: true,
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => {
    if (typeof value === 'boolean') {
      return value;
    }

    if (value === 'true') {
      return true;
    }

    if (value === 'false') {
      return false;
    }

    return value;
  })
  @IsBoolean()
  refresh?: boolean;
}
