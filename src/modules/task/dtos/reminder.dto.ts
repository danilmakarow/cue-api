import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsInt, Max, Min } from 'class-validator';

import { NotificationChannel } from '@/modules/database/entities';

/**
 * A single per-task reminder on the create/update payload (S1): an offset from
 * the task start (in minutes; negative fires before, positive after) plus the
 * delivery channel. Persisted as a `taskId`-linked `NotificationRule` row.
 */
export class ReminderDto {
  @ApiProperty({
    example: -15,
    description:
      'Offset in minutes from the task start. Negative fires before, positive after.',
  })
  @IsInt()
  // Bound to a sane window (±1 week) so a stray value cannot schedule absurd offsets.
  @Min(-10080)
  @Max(10080)
  offsetMinutes: number;

  @ApiProperty({
    enum: NotificationChannel,
    example: NotificationChannel.PUSH,
    description: 'Delivery channel for this reminder.',
  })
  @IsEnum(NotificationChannel)
  channel: NotificationChannel;
}

/**
 * Wire shape for a per-task reminder returned on `TaskDTO` (S1). Carries the
 * persisted rule id so the client can correlate, plus the offset + channel.
 */
export class ReminderResultDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: -15 })
  offsetMinutes: number;

  @ApiProperty({ enum: NotificationChannel, example: NotificationChannel.PUSH })
  channel: NotificationChannel;
}
