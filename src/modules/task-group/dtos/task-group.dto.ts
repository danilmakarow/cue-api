import { TaskGroup } from '@/modules/database/entities';
import {
  RecurrenceRuleDTO,
  toRecurrenceRuleDTO,
} from '@/modules/task/dtos/task.dto';

/**
 * Wire shape for a TaskGroup response. Returned by all task-group endpoints.
 * Field names are normative per the FE contract (Part C).
 */
export interface TaskGroupDTO {
  id: string;
  calendarId: string;
  name: string;
  color: string | null;
  icon: string | null;
  sortOrder: number;
  defaultRecurrenceRuleId: string | null;
  recurrence: RecurrenceRuleDTO | null;
  defaultNotificationStrategyId: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Maps a TaskGroup entity (with optional eagerly-loaded `defaultRecurrenceRule`
 * relation) to the `TaskGroupDTO` wire shape.
 */
export const toTaskGroupDTO = (group: TaskGroup): TaskGroupDTO => ({
  id: group.id,
  calendarId: group.calendarId,
  name: group.name,
  color: group.color,
  icon: group.icon,
  sortOrder: group.sortOrder,
  defaultRecurrenceRuleId: group.defaultRecurrenceRuleId,
  recurrence: group.defaultRecurrenceRule
    ? toRecurrenceRuleDTO(group.defaultRecurrenceRule)
    : null,
  defaultNotificationStrategyId: group.defaultNotificationStrategyId,
  createdAt: group.createdAt.toISOString(),
  updatedAt: group.updatedAt.toISOString(),
});
