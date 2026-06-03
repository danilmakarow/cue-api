import { Column, Entity, JoinColumn, ManyToOne, OneToMany } from 'typeorm';

import { BaseEntity } from './base.entity';
import { Calendar } from './calendar.entity';
import { NotificationStrategy } from './notification-strategy.entity';
import { RecurrenceRule } from './recurrence-rule.entity';
import { Task } from './task.entity';

/**
 * TaskGroup entity representing a calendar-owned bucket of tasks (e.g. "Work", "Home").
 * Groups optionally carry a default notification strategy and a default recurrence rule
 * inherited by contained tasks.
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

  @Column({ type: String, nullable: true })
  color: string | null;

  @Column({ type: String, nullable: true })
  icon: string | null;

  @Column({ type: 'uuid', nullable: true })
  defaultNotificationStrategyId: string | null;

  @ManyToOne(() => NotificationStrategy, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'defaultNotificationStrategyId' })
  defaultNotificationStrategy: NotificationStrategy | null;

  @Column({ type: 'uuid', nullable: true })
  defaultRecurrenceRuleId: string | null;

  @ManyToOne(() => RecurrenceRule, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'defaultRecurrenceRuleId' })
  defaultRecurrenceRule: RecurrenceRule | null;

  @Column({ type: 'int', default: 0 })
  sortOrder: number;

  @OneToMany(() => Task, (task) => task.group)
  tasks: Task[];
}
