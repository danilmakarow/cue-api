import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, Matches } from 'class-validator';

/** Validates a zero-padded ISO local date `YYYY-MM-DD`. */
export const DAILY_BRIEF_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Query parameters for GET `/users/me/daily-brief` (backlog D2). `date` is an
 * optional local `YYYY-MM-DD` interpreted in the user's timezone; when omitted
 * the brief covers the user's CURRENT local day. The strict `YYYY-MM-DD` shape is
 * enforced here so a malformed value is rejected with 400 before the service
 * spends a MAIN-model call.
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
}
