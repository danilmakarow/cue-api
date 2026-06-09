import { ApiProperty } from '@nestjs/swagger';

import { RecurrenceRule, Task } from '@/modules/database/entities';
import { Occurrence } from '@/modules/recurrence-rule/recurrence.types';

/**
 * Wire shape for a RecurrenceRule embedded in task/group responses.
 * Field names are normative per the FE contract (Part C).
 *
 * Modelled as a class (not an interface) so `@ApiProperty` can describe it for
 * Swagger; the `toRecurrenceRuleDTO` mapper returns a structurally compatible
 * object literal — no instantiation needed.
 */
export class RecurrenceRuleDTO {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'WEEKLY' })
  frequency: string;

  @ApiProperty({ example: 1 })
  interval: number;

  @ApiProperty({ type: [Number], nullable: true, example: [0, 2, 4] })
  byWeekday: number[] | null;

  @ApiProperty({ type: [Number], nullable: true, example: [1, 15] })
  byMonthDay: number[] | null;

  @ApiProperty({ type: [Number], nullable: true, example: [1, 6, 12] })
  byMonth: number[] | null;

  @ApiProperty({ example: 'NEVER' })
  endType: string;

  @ApiProperty({ nullable: true, example: '2026-12-31' })
  endDate: string | null;

  @ApiProperty({ nullable: true, example: 10 })
  count: number | null;
}

/**
 * Wire shape for a Task series row. Returned by POST /tasks, PATCH /tasks/:id,
 * GET /tasks/:id. Includes the embedded recurrence rule for editing.
 */
export class TaskDTO {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  calendarId: string;

  @ApiProperty({ format: 'uuid', nullable: true })
  groupId: string | null;

  @ApiProperty({ example: 'Buy groceries' })
  title: string;

  @ApiProperty({ nullable: true, example: 'Milk, eggs, bread' })
  notes: string | null;

  @ApiProperty({ format: 'date-time', nullable: true })
  startAt: string | null;

  @ApiProperty({ format: 'date-time', nullable: true })
  endAt: string | null;

  @ApiProperty()
  isAllDay: boolean;

  @ApiProperty({ example: 'Europe/Berlin' })
  timezone: string;

  @ApiProperty()
  requiresCompletion: boolean;

  @ApiProperty({ format: 'date-time', nullable: true })
  completedAt: string | null;

  @ApiProperty({ format: 'uuid', nullable: true })
  recurrenceRuleId: string | null;

  @ApiProperty({ type: () => RecurrenceRuleDTO, nullable: true })
  recurrence: RecurrenceRuleDTO | null;

  @ApiProperty({ format: 'uuid', nullable: true })
  notificationStrategyId: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt: string;
}

/**
 * Wire shape for a single expanded occurrence. Returned by GET /tasks.
 * One per visible instance — recurring tasks produce one per occurrence date.
 */
export class OccurrenceDTO {
  @ApiProperty({ format: 'uuid' })
  taskId: string;

  @ApiProperty({ format: 'uuid' })
  calendarId: string;

  @ApiProperty({ format: 'uuid', nullable: true })
  groupId: string | null;

  @ApiProperty({ format: 'date-time', nullable: true })
  originalStart: string | null;

  @ApiProperty({ format: 'date-time', nullable: true })
  occurrenceStart: string | null;

  @ApiProperty({ format: 'date-time', nullable: true })
  occurrenceEnd: string | null;

  @ApiProperty({ example: 'Buy groceries' })
  title: string;

  @ApiProperty({ nullable: true })
  notes: string | null;

  @ApiProperty()
  isAllDay: boolean;

  @ApiProperty({ example: 'Europe/Berlin' })
  timezone: string;

  @ApiProperty()
  requiresCompletion: boolean;

  @ApiProperty({ format: 'date-time', nullable: true })
  completedAt: string | null;

  @ApiProperty()
  isRecurring: boolean;

  @ApiProperty()
  isException: boolean;
}

/**
 * Wire shape returned by PATCH /tasks/:id/completion.
 */
export class CompletionResultDTO {
  @ApiProperty({ format: 'uuid' })
  taskId: string;

  @ApiProperty({ format: 'date-time', nullable: true })
  occurrenceStart: string | null;

  @ApiProperty({ format: 'date-time', nullable: true })
  completedAt: string | null;
}

/**
 * Maps a RecurrenceRule entity to its DTO wire shape.
 */
export const toRecurrenceRuleDTO = (
  rule: RecurrenceRule,
): RecurrenceRuleDTO => ({
  id: rule.id,
  frequency: rule.frequency,
  interval: rule.interval,
  byWeekday: rule.byWeekday,
  byMonthDay: rule.byMonthDay,
  byMonth: rule.byMonth,
  endType: rule.endType,
  endDate: rule.endDate,
  count: rule.count,
});

/**
 * Maps a Task entity (with optional eagerly-loaded `recurrenceRule` relation) to
 * the `TaskDTO` wire shape. The `recurrence` field is populated only when the
 * relation is loaded; if you need it, use `findByIdWithRule`.
 */
export const toTaskDTO = (task: Task): TaskDTO => ({
  id: task.id,
  calendarId: task.calendarId,
  groupId: task.groupId,
  title: task.title,
  notes: task.notes,
  startAt: task.startAt ? task.startAt.toISOString() : null,
  endAt: task.endAt ? task.endAt.toISOString() : null,
  isAllDay: task.isAllDay,
  timezone: task.timezone,
  requiresCompletion: task.requiresCompletion,
  completedAt: task.completedAt ? task.completedAt.toISOString() : null,
  recurrenceRuleId: task.recurrenceRuleId,
  recurrence: task.recurrenceRule
    ? toRecurrenceRuleDTO(task.recurrenceRule)
    : null,
  notificationStrategyId: task.notificationStrategyId,
  createdAt: task.createdAt.toISOString(),
  updatedAt: task.updatedAt.toISOString(),
});

/**
 * Maps a computed `Occurrence` value to the `OccurrenceDTO` wire shape.
 * Picks only the fields the FE needs — does NOT serialize the full `task` entity.
 */
export const toOccurrenceDTO = (occurrence: Occurrence): OccurrenceDTO => ({
  taskId: occurrence.task.id,
  calendarId: occurrence.task.calendarId,
  groupId: occurrence.task.groupId,
  originalStart: occurrence.originalStart
    ? occurrence.originalStart.toISOString()
    : null,
  occurrenceStart: occurrence.occurrenceStart
    ? occurrence.occurrenceStart.toISOString()
    : null,
  occurrenceEnd: occurrence.occurrenceEnd
    ? occurrence.occurrenceEnd.toISOString()
    : null,
  title: occurrence.title,
  notes: occurrence.task.notes,
  isAllDay: occurrence.task.isAllDay,
  timezone: occurrence.task.timezone,
  requiresCompletion: occurrence.task.requiresCompletion,
  completedAt: occurrence.completedAt
    ? occurrence.completedAt.toISOString()
    : null,
  isRecurring: occurrence.isRecurring,
  isException: occurrence.isException,
});
