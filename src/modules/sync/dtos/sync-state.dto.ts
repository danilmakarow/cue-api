import { ApiProperty } from '@nestjs/swagger';

/**
 * Response body for `GET /sync/state` — the cheap "did anything change since X?"
 * check. Clients compare {@link SyncStateDto.revision} against the last value
 * they saw: different ⇒ run the delta pull; equal ⇒ skip the network round-trip.
 */
export class SyncStateDto {
  @ApiProperty({
    example: '42',
    description:
      'Monotonic per-user revision (bigint serialized as string). Opaque equality token — "0" when no mutation has occurred yet.',
  })
  revision: string;

  @ApiProperty({
    type: String,
    nullable: true,
    format: 'date-time',
    description: 'Timestamp of the most recent bump; null when revision is "0".',
  })
  changedAt: string | null;

  @ApiProperty({
    format: 'date-time',
    description: 'Current server time, for client clock-skew diagnostics.',
  })
  serverTime: string;
}
