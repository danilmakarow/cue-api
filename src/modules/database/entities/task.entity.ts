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
import { NotificationStrategy } from './notification-strategy.entity';
import { RecurrenceRule } from './recurrence-rule.entity';
import { TaskGroup } from './task-group.entity';
import { TaskOccurrenceException } from './task-occurrence-exception.entity';
import { User } from './user.entity';

/**
 * Task entity — the unified event+todo primitive for Cue.
 * Supports all-day and timed occurrences, optional recurrence, per-task timezone, and soft deletion.
 * Indexed on (userId, startAt) to serve user calendar and agenda queries efficiently.
 */
@Entity()
@Index(['userId', 'startAt'])
export class Task extends BaseEntity {
  @Column()
  userId: string;

  @ManyToOne(() => User, (user) => user.tasks, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

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

  @Column({ default: true })
  requiresCompletion: boolean;

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

  @Column({ type: 'uuid', nullable: true })
  recurrenceRuleId: string | null;

  @ManyToOne(() => RecurrenceRule, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'recurrenceRuleId' })
  recurrenceRule: RecurrenceRule | null;

  @DeleteDateColumn({ type: 'timestamptz' })
  deletedAt: Date | null;

  @OneToMany(() => TaskOccurrenceException, (exception) => exception.task)
  occurrenceExceptions: TaskOccurrenceException[];
}
