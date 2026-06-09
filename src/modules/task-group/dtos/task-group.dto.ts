import { ApiProperty } from '@nestjs/swagger';

import { TaskGroup } from '@/modules/database/entities';
import {
  RecurrenceRuleDTO,
  toRecurrenceRuleDTO,
} from '@/modules/task/dtos/task.dto';

/**
 * Wire shape for a TaskGroup response. Returned by all task-group endpoints.
 * Field names are normative per the FE contract (Part C).
 *
 * Modelled as a class (not an interface) so `@ApiProperty` can describe it for
 * Swagger; the `toTaskGroupDTO` mapper returns a structurally compatible object
 * literal — no instantiation needed.
 */
export class TaskGroupDTO {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  calendarId: string;

  @ApiProperty({ example: 'Errands' })
  name: string;

  @ApiProperty({ nullable: true, example: '#E27921' })
  color: string | null;

  @ApiProperty({ nullable: true, example: 'cart.fill' })
  icon: string | null;

  @ApiProperty({ example: 0 })
  sortOrder: number;

  @ApiProperty({ format: 'uuid', nullable: true })
  defaultRecurrenceRuleId: string | null;

  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  @ApiProperty({ type: () => RecurrenceRuleDTO, nullable: true })
  recurrence: RecurrenceRuleDTO | null;

  @ApiProperty({ format: 'uuid', nullable: true })
  defaultNotificationStrategyId: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt: string;

  @ApiProperty({ format: 'date-time' })
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
