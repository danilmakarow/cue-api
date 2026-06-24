import { Column, Entity, JoinColumn, ManyToOne, OneToMany } from 'typeorm';

import { BaseEntity } from './base.entity';
import { Calendar } from './calendar.entity';
import { NotificationStrategy } from './notification-strategy.entity';
import { Task } from './task.entity';
import type { RecurrenceConfig } from '@/modules/recurrence-rule/recurrence.types';

/**
 * TaskGroup entity representing a calendar-owned bucket of tasks (e.g. "Work", "Home").
 * Groups optionally carry a default notification strategy plus default recurrence,
 * color, and completion-requirement settings inherited by contained tasks (the
 * effective-settings resolver applies task-wins inheritance).
 */
@Entity()
export class TaskGroup extends BaseEntity {
  @Column()
  calendarId: string;

  @ManyToOne(() => Calendar, (calendar) => calendar.taskGroups, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'calendarId' })
  calendar: Calendar;

  @Column()
  name: string;

  /**
   * Default display color inherited by tasks with no own color: a {@link TaskColor}
   * preset name OR a custom `#RRGGBB` hex.
   */
  @Column({ type: String, nullable: true })
  color: string | null;

  @Column({ type: String, nullable: true })
  icon: string | null;

  /**
   * Default completion requirement inherited by tasks with no own value (task-wins).
   * Null means "no group default" — the resolver then falls back to `false`.
   */
  @Column({ type: 'boolean', nullable: true })
  requiresCompletion: boolean | null;

  @Column({ type: 'uuid', nullable: true })
  defaultNotificationStrategyId: string | null;

  @ManyToOne(() => NotificationStrategy, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'defaultNotificationStrategyId' })
  defaultNotificationStrategy: NotificationStrategy | null;

  /**
   * Default inline recurrence configuration (JSONB) inherited by tasks with no own
   * `recurrenceConfig`. Replaces the former `defaultRecurrenceRuleId` FK relation
   * (ADR 0054).
   */
  @Column({ type: 'jsonb', nullable: true })
  recurrenceConfig: RecurrenceConfig | null;

  @Column({ type: 'int', default: 0 })
  sortOrder: number;

  @OneToMany(() => Task, (task) => task.group)
  tasks: Task[];
}
