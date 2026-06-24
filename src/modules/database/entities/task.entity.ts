import {
  Column,
  DeleteDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
} from 'typeorm';

import { BaseEntity } from './base.entity';
import { Calendar } from './calendar.entity';
import { NotificationStrategy } from './notification-strategy.entity';
import { TaskGroup } from './task-group.entity';
import { TaskOccurrenceException } from './task-occurrence-exception.entity';
import type { RecurrenceConfig } from '@/modules/recurrence-rule/recurrence.types';

/**
 * Task entity — the unified event+todo primitive for Cue.
 * Supports all-day and timed occurrences, optional recurrence, per-task timezone, and soft deletion.
 * Indexed on (calendarId, startAt) to serve calendar and agenda queries efficiently.
 */
@Entity()
@Index(['calendarId', 'startAt'])
export class Task extends BaseEntity {
  @Column()
  calendarId: string;

  @ManyToOne(() => Calendar, (calendar) => calendar.tasks, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'calendarId' })
  calendar: Calendar;

  @Column({ type: 'uuid', nullable: true })
  groupId: string | null;

  @ManyToOne(() => TaskGroup, (group) => group.tasks, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'groupId' })
  group: TaskGroup | null;

  @Column()
  title: string;

  @Column({ type: 'text', nullable: true })
  notes: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  startAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  endAt: Date | null;

  @Column({ default: false })
  isAllDay: boolean;

  /**
   * IANA timezone name. Stored per-task so that recurring local-time expansions
   * remain correct across DST transitions and user travel.
   */
  @Column()
  timezone: string;

  /**
   * Per-task completion requirement. Nullable: when null the effective value is
   * resolved task-wins as `task.requiresCompletion ?? group.requiresCompletion ??
   * false` (the default lives in the resolver, NOT as a column default).
   */
  @Column({ type: 'boolean', nullable: true })
  requiresCompletion: boolean | null;

  /**
   * Display color: a {@link TaskColor} preset name OR a custom `#RRGGBB` hex.
   * Null inherits the group color via the effective-settings resolver.
   */
  @Column({ type: 'varchar', nullable: true })
  color: string | null;

  /**
   * Set to the completion timestamp when the task is marked done. Stored as a timestamp rather
   * than a boolean so reporting can aggregate completion events over time.
   */
  @Column({ type: 'timestamptz', nullable: true })
  completedAt: Date | null;

  @Column({ type: 'uuid', nullable: true })
  notificationStrategyId: string | null;

  @ManyToOne(() => NotificationStrategy, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'notificationStrategyId' })
  notificationStrategy: NotificationStrategy | null;

  /**
   * Inline recurrence configuration (JSONB), or null for a non-recurring task.
   * Replaces the former `recurrenceRuleId` FK + `recurrenceRule` relation — the
   * rule now lives on the row itself (ADR 0054).
   */
  @Column({ type: 'jsonb', nullable: true })
  recurrenceConfig: RecurrenceConfig | null;

  @DeleteDateColumn({ type: 'timestamptz' })
  deletedAt: Date | null;

  @OneToMany(() => TaskOccurrenceException, (exception) => exception.task)
  occurrenceExceptions: TaskOccurrenceException[];
}
