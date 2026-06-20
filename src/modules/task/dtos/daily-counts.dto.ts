import { ApiProperty } from '@nestjs/swagger';

/**
 * Wire shape for the per-day occurrence-count read. `counts` maps a local date
 * (`YYYY-MM-DD`, in each task's timezone) to the number of occurrences bucketed
 * onto that date. Zero-count days are omitted entirely.
 */
export class DailyCountsDTO {
  @ApiProperty({
    description:
      'Occurrence count per local date (YYYY-MM-DD). Zero-count days omitted.',
    type: 'object',
    additionalProperties: { type: 'integer' },
    example: { '2026-06-20': 3, '2026-06-21': 1, '2026-06-23': 2 },
  })
  counts: Record<string, number>;
}
