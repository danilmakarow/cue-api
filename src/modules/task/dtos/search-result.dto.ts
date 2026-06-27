import { ApiProperty } from '@nestjs/swagger';

import { Task } from '@/modules/database/entities';

/**
 * A single task search hit (M1). Carries the matched series row's identity and
 * its anchor date/time plus the owning group's id + color, so the search screen
 * can render the row with its real group color and navigate to its date — even
 * for recurring series, where this is the anchor occurrence (callers expand
 * occurrences separately for the calendar view).
 */
export class TaskSearchResultDTO {
  @ApiProperty({ format: 'uuid' })
  taskId: string;

  @ApiProperty({ format: 'uuid' })
  calendarId: string;

  @ApiProperty({ format: 'uuid', nullable: true })
  groupId: string | null;

  /** The owning group's color (preset name or `#RRGGBB`); null when ungrouped. */
  @ApiProperty({ nullable: true, example: '#E27921' })
  groupColorHex: string | null;

  @ApiProperty({ example: 'Dentist appointment' })
  title: string;

  @ApiProperty({ nullable: true, example: 'Bring insurance card' })
  notes: string | null;

  @ApiProperty({ format: 'date-time', nullable: true })
  startAt: string | null;

  @ApiProperty({ format: 'date-time', nullable: true })
  endAt: string | null;

  @ApiProperty()
  isAllDay: boolean;

  @ApiProperty({ example: 'Europe/Berlin' })
  timezone: string;

  /** True when the matched task is a recurring series (`startAt` is its anchor). */
  @ApiProperty()
  isRecurring: boolean;
}

/**
 * Maps a Task entity (with its `group` relation optionally loaded) to a search
 * hit. The group color is read from `task.group` — null when ungrouped or the
 * relation was not loaded.
 */
export const toTaskSearchResultDTO = (task: Task): TaskSearchResultDTO => ({
  taskId: task.id,
  calendarId: task.calendarId,
  groupId: task.groupId,
  groupColorHex: task.group?.color ?? null,
  title: task.title,
  notes: task.notes,
  startAt: task.startAt ? task.startAt.toISOString() : null,
  endAt: task.endAt ? task.endAt.toISOString() : null,
  isAllDay: task.isAllDay,
  timezone: task.timezone,
  isRecurring: task.recurrenceConfig !== null,
});
