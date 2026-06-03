import { RecurrenceRule, Task } from '@/modules/database/entities';
import { Occurrence } from '@/modules/recurrence-rule/recurrence.types';

/**
 * Wire shape for a RecurrenceRule embedded in task/group responses.
 * Field names are normative per the FE contract (Part C).
 */
export interface RecurrenceRuleDTO {
  id: string;
  frequency: string;
  interval: number;
  byWeekday: number[] | null;
  byMonthDay: number[] | null;
  byMonth: number[] | null;
  endType: string;
  endDate: string | null;
  count: number | null;
}

/**
 * Wire shape for a Task series row. Returned by POST /tasks, PATCH /tasks/:id,
 * GET /tasks/:id. Includes the embedded recurrence rule for editing.
 */
export interface TaskDTO {
  id: string;
  calendarId: string;
  groupId: string | null;
  title: string;
  notes: string | null;
  startAt: string | null;
  endAt: string | null;
  isAllDay: boolean;
  timezone: string;
  requiresCompletion: boolean;
  completedAt: string | null;
  recurrenceRuleId: string | null;
  recurrence: RecurrenceRuleDTO | null;
  notificationStrategyId: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Wire shape for a single expanded occurrence. Returned by GET /tasks.
 * One per visible instance — recurring tasks produce one per occurrence date.
 */
export interface OccurrenceDTO {
  taskId: string;
  calendarId: string;
  groupId: string | null;
  originalStart: string | null;
  occurrenceStart: string | null;
  occurrenceEnd: string | null;
  title: string;
  notes: string | null;
  isAllDay: boolean;
  timezone: string;
  requiresCompletion: boolean;
  completedAt: string | null;
  isRecurring: boolean;
  isException: boolean;
}

/**
 * Wire shape returned by PATCH /tasks/:id/completion.
 */
export interface CompletionResultDTO {
  taskId: string;
  occurrenceStart: string | null;
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
