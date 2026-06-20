import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsISO8601, IsOptional, IsUUID } from 'class-validator';

import { TaskDTO } from './task.dto';
import { TaskOccurrenceException } from '@/modules/database/entities';

/**
 * Query parameters for the precise change-detection (delta) read. The client
 * echoes the previous response's `serverTime` as `since` on each subsequent
 * call (opaque cursor). On the very first call `since` is omitted, signalling
 * the client to fall back to a full per-window SWR sync rather than a delta.
 */
export class ChangesQuery {
  @ApiProperty({
    format: 'uuid',
    description: 'Calendar to compute the delta for.',
  })
  @IsUUID()
  calendarId: string;

  /**
   * Opaque cursor — the `serverTime` returned by the previous delta call,
   * echoed verbatim. ISO-8601. Omitted/empty on the first call.
   */
  @ApiPropertyOptional({
    format: 'date-time',
    description:
      'Opaque cursor: the previous response serverTime. Omit on first call.',
    example: '2026-06-20T14:35:22.145Z',
  })
  @IsOptional()
  @IsISO8601()
  since?: string;

  /**
   * When `true`, timeless todos are included in the changed-series set.
   * Defaults to `true` — the delta carries every changed series regardless of
   * whether it has a start time, since the client invalidates by series id.
   */
  @ApiPropertyOptional({
    default: true,
    description: 'Include timeless todos in the changed-series set.',
  })
  @IsOptional()
  @IsBoolean()
  @Transform(
    ({ value }: { value: unknown }) => value === 'true' || value === true,
  )
  includeTodos?: boolean;
}

/**
 * Wire shape for a TaskOccurrenceException row carried by the delta response.
 * Mirrors the entity's mutable fields plus its identity (`taskId`,
 * `originalStartAt`) so the client can invalidate the window containing the
 * occurrence.
 */
export class TaskOccurrenceExceptionDTO {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  taskId: string;

  @ApiProperty({ format: 'date-time' })
  originalStartAt: string;

  @ApiProperty()
  isSkipped: boolean;

  @ApiProperty({ format: 'date-time', nullable: true })
  overrideStartAt: string | null;

  @ApiProperty({ format: 'date-time', nullable: true })
  overrideEndAt: string | null;

  @ApiProperty({ nullable: true, example: 'Moved to afternoon' })
  overrideTitle: string | null;

  @ApiProperty({ format: 'date-time', nullable: true })
  completedAt: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt: string;
}

/**
 * Wire shape returned by GET /tasks/changes. `tasks` are the changed series
 * (incl. embedded recurrence), `deleted` the soft-deleted series ids,
 * `exceptions` the changed per-occurrence overrides, and `serverTime` the
 * opaque cursor the client echoes on its next call.
 */
export class ChangesDTO {
  @ApiProperty({ type: () => [TaskDTO] })
  tasks: TaskDTO[];

  @ApiProperty({ type: [String], example: ['task-old-1', 'task-old-2'] })
  deleted: string[];

  @ApiProperty({ type: () => [TaskOccurrenceExceptionDTO] })
  exceptions: TaskOccurrenceExceptionDTO[];

  @ApiProperty({ format: 'date-time', example: '2026-06-20T14:35:22.145Z' })
  serverTime: string;
}

/**
 * Maps a TaskOccurrenceException entity to its DTO wire shape.
 */
export const toTaskOccurrenceExceptionDTO = (
  exception: TaskOccurrenceException,
): TaskOccurrenceExceptionDTO => ({
  id: exception.id,
  taskId: exception.taskId,
  originalStartAt: exception.originalStartAt.toISOString(),
  isSkipped: exception.isSkipped,
  overrideStartAt: exception.overrideStartAt
    ? exception.overrideStartAt.toISOString()
    : null,
  overrideEndAt: exception.overrideEndAt
    ? exception.overrideEndAt.toISOString()
    : null,
  overrideTitle: exception.overrideTitle,
  completedAt: exception.completedAt
    ? exception.completedAt.toISOString()
    : null,
  createdAt: exception.createdAt.toISOString(),
  updatedAt: exception.updatedAt.toISOString(),
});
