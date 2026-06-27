import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';

import { BaseEntity } from './base.entity';
import { NotificationStrategy } from './notification-strategy.entity';
import { Task } from './task.entity';

/**
 * Enumeration of delivery channels available for outbound notifications.
 */
export enum NotificationChannel {
  PUSH = 'PUSH',
  TELEGRAM = 'TELEGRAM',
}

/**
 * NotificationRule entity describing a single alert offset + channel.
 *
 * A rule belongs to EXACTLY ONE of two owners:
 * - a {@link NotificationStrategy} (a reusable named bundle), via `strategyId`, or
 * - a single {@link Task} directly (a per-task reminder, S1), via `taskId`.
 *
 * Both FK columns are nullable so either ownership is expressible; the per-task
 * reminders feature persists `taskId`-linked rows (strategy null) and replaces
 * the whole set on each task create/update.
 */
@Entity()
export class NotificationRule extends BaseEntity {
  @Column({ type: 'uuid', nullable: true })
  strategyId: string | null;

  @ManyToOne(() => NotificationStrategy, (strategy) => strategy.rules, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'strategyId' })
  strategy: NotificationStrategy | null;

  /**
   * Owning task for a per-task reminder (S1). Null for strategy-owned rules.
   * Indexed for the list-by-task / replace-on-update reads; cascades on task
   * delete so a removed task takes its reminders with it.
   */
  @Index()
  @Column({ type: 'uuid', nullable: true })
  taskId: string | null;

  @ManyToOne(() => Task, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'taskId' })
  task: Task | null;

  /**
   * Offset in minutes from the task's start. Typically negative — e.g. -15 means "fire 15 minutes
   * before the task starts". Positive values are allowed for after-the-fact reminders.
   */
  @Column({ type: 'int' })
  offsetMinutes: number;

  @Column({ type: 'enum', enum: NotificationChannel })
  channel: NotificationChannel;

  @Column({ type: 'text', nullable: true })
  messageTemplate: string | null;
}
