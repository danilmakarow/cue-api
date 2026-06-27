import { ApiProperty } from '@nestjs/swagger';

/**
 * Response DTO for GET `/users/me/daily-brief` (backlog D2). Carries the
 * generated morning-brief text the iOS today card renders, plus the resolved
 * local date the brief covers so the client can label / cache it. `brief` is
 * `null` when generation produced nothing usable for the day (the client then
 * shows an empty state rather than stale text).
 */
export class DailyBriefDTO {
  @ApiProperty({
    description:
      'The generated daily-brief text for the day, or null when the model ' +
      'produced nothing usable (empty schedule fallback handling is the client’s).',
    nullable: true,
    example: 'Good morning, Tony. You have a 10:00 dentist and a 14:00 sync.',
  })
  brief: string | null;

  @ApiProperty({
    description:
      'The local date (`YYYY-MM-DD`, in the user timezone) the brief covers.',
    example: '2026-06-27',
  })
  localDate: string;
}
