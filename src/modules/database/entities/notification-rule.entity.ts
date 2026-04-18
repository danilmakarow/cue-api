import { Column, Entity, JoinColumn, ManyToOne } from 'typeorm';

import { BaseEntity } from './base.entity';
import { NotificationStrategy } from './notification-strategy.entity';

/**
 * Enumeration of delivery channels available for outbound notifications.
 */
export enum NotificationChannel {
  PUSH = 'PUSH',
  TELEGRAM = 'TELEGRAM',
}

/**
 * NotificationRule entity describing a single alert within a NotificationStrategy.
 * Strategies combine multiple rules to produce per-task notification plans.
 */
@Entity()
export class NotificationRule extends BaseEntity {
  @Column()
  strategyId: string;

  @ManyToOne(() => NotificationStrategy, (strategy) => strategy.rules, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'strategyId' })
  strategy: NotificationStrategy;

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
