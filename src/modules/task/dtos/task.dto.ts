import { ApiProperty } from '@nestjs/swagger';

import { resolveEffectiveSettings } from '../effective-settings';
import { ReminderResultDto } from './reminder.dto';
import { NotificationRule, Task } from '@/modules/database/entities';
import {
  Occurrence,
  RecurrenceConfig,
} from '@/modules/recurrence-rule/recurrence.types';

/**
 * Wire shape for an inline recurrence config embedded in task/group responses
 * (ADR 0054). Field names are normative per the FE contract (Part C). Unlike the
 * former `RecurrenceRuleDTO` it carries NO `id` — recurrence is no longer a row.
 *
 * Modelled as a class (not an interface) so `@ApiProperty` can describe it for
 * Swagger; the `toRecurrenceConfigDTO` mapper returns a structurally compatible
 * object literal — no instantiation needed.
 */
export class RecurrenceConfigDTO {
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
 * GET /tasks/:id. Includes the inline recurrence config for editing.
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

  /** Task's OWN value; null means "inherit" (resolve task-wins on the client). */
  @ApiProperty({ nullable: true })
  requiresCompletion: boolean | null;

  /** Task's OWN color (preset name or `#RRGGBB`); null inherits the group color. */
  @ApiProperty({ nullable: true, example: 'BLUE' })
  color: string | null;

  /** Per-task icon (SF Symbol name); null leaves the task iconless. */
  @ApiProperty({ nullable: true, example: 'cart.fill' })
  icon: string | null;

  @ApiProperty({ format: 'date-time', nullable: true })
  completedAt: string | null;

  @ApiProperty({ type: () => RecurrenceConfigDTO, nullable: true })
  recurrence: RecurrenceConfigDTO | null;

  /** The task's own per-task reminders (offset + channel), earliest first. */
  @ApiProperty({ type: () => [ReminderResultDto] })
  reminders: ReminderResultDto[];

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
 * `requiresCompletion` / `color` / `isRecurring` reflect the EFFECTIVE
 * (task-wins-over-group) settings so the client renders one resolved value.
 */
export class OccurrenceDTO {
  @ApiProperty({ format: 'uuid' })
  taskId: string;

  @ApiProperty({ format: 'uuid' })
  calendarId: string;

  @ApiProperty({ format: 'uuid', nullable: true })
  groupId: string | null;

  /**
   * The owning group's color (a preset name or `#RRGGBB`), null when ungrouped
   * or the group's relation was not loaded. Carried alongside `groupId` so the
   * day rails / month dots render real group colors (B2) even when the task has
   * its own `color` override.
   */
  @ApiProperty({ nullable: true, example: '#E27921' })
  groupColorHex: string | null;

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

  /** EFFECTIVE completion requirement (task ?? group ?? false). */
  @ApiProperty()
  requiresCompletion: boolean;

  /** EFFECTIVE color (task ?? group ?? null). */
  @ApiProperty({ nullable: true, example: 'BLUE' })
  color: string | null;

  /** Per-task icon (SF Symbol name); null leaves the occurrence iconless. */
  @ApiProperty({ nullable: true, example: 'cart.fill' })
  icon: string | null;

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
 * Maps an inline RecurrenceConfig to its DTO wire shape (no id).
 */
export const toRecurrenceConfigDTO = (
  config: RecurrenceConfig,
): RecurrenceConfigDTO => ({
  frequency: config.frequency,
  interval: config.interval,
  byWeekday: config.byWeekday,
  byMonthDay: config.byMonthDay,
  byMonth: config.byMonth,
  endType: config.endType,
  endDate: config.endDate,
  count: config.count,
});

/**
 * Maps a `NotificationRule` row to its per-task `ReminderResultDto` wire shape.
 */
export const toReminderResultDto = (
  rule: NotificationRule,
): ReminderResultDto => ({
  id: rule.id,
  offsetMinutes: rule.offsetMinutes,
  channel: rule.channel,
});

/**
 * Maps a Task entity to the `TaskDTO` wire shape. `recurrence` is the inline
 * `recurrenceConfig` on the row (its OWN config, not the group-inherited one);
 * `requiresCompletion` / `color` are the task's OWN (nullable) values so the
 * client can distinguish "inherit" from an explicit setting. `reminders` are the
 * task's own per-task notification rules — passed in by the caller (the service
 * loads them); defaults to an empty array when not supplied.
 */
export const toTaskDTO = (
  task: Task,
  reminders: NotificationRule[] = [],
): TaskDTO => ({
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
  color: task.color,
  icon: task.icon,
  completedAt: task.completedAt ? task.completedAt.toISOString() : null,
  recurrence: task.recurrenceConfig
    ? toRecurrenceConfigDTO(task.recurrenceConfig)
    : null,
  reminders: reminders.map(toReminderResultDto),
  notificationStrategyId: task.notificationStrategyId,
  createdAt: task.createdAt.toISOString(),
  updatedAt: task.updatedAt.toISOString(),
});

/**
 * Maps a computed `Occurrence` value to the `OccurrenceDTO` wire shape.
 * Picks only the fields the FE needs — does NOT serialize the full `task` entity.
 * `requiresCompletion` / `color` are resolved EFFECTIVE (task-wins over group)
 * via {@link resolveEffectiveSettings}; group inheritance is honored only when the
 * occurrence's `task.group` relation was loaded.
 */
export const toOccurrenceDTO = (occurrence: Occurrence): OccurrenceDTO => {
  const effective = resolveEffectiveSettings(occurrence.task);

  return {
    taskId: occurrence.task.id,
    calendarId: occurrence.task.calendarId,
    groupId: occurrence.task.groupId,
    // The owning group's own color — honored only when the group relation was
    // loaded (else null). Distinct from the EFFECTIVE `color` below, which a
    // task-level override can shadow.
    groupColorHex: occurrence.task.group?.color ?? null,
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
    requiresCompletion: effective.requiresCompletion,
    color: effective.color,
    icon: occurrence.task.icon,
    completedAt: occurrence.completedAt
      ? occurrence.completedAt.toISOString()
      : null,
    isRecurring: occurrence.isRecurring,
    isException: occurrence.isException,
  };
};
