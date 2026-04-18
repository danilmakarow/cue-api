import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';

import { BaseEntity } from './base.entity';
import { NotificationChannel } from './notification-rule.entity';
import { Task } from './task.entity';
import { User } from './user.entity';

/**
 * Lifecycle status of an outbound scheduled notification in the delivery queue.
 */
export enum ScheduledNotificationStatus {
  PENDING = 'PENDING',
  SENT = 'SENT',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
}

/**
 * ScheduledNotification entity acting as the outbox / delivery queue for reminders.
 * The worker polls this table for `fireAt <= now() AND status = 'PENDING'`, which is served by
 * the composite (status, fireAt) index. A standalone index on fireAt aids scan queries and ops.
 */
@Entity()
@Index(['status', 'fireAt'])
@Index(['fireAt'])
export class ScheduledNotification extends BaseEntity {
  @Column()
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column()
  taskId: string;

  @ManyToOne(() => Task, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'taskId' })
  task: Task;

  /**
   * Start timestamp of the specific occurrence this notification is for.
   * Combined with taskId it uniquely identifies an instance of a recurring task.
   */
  @Column({ type: 'timestamptz' })
  occurrenceStartAt: Date;

  @Column({ type: 'timestamptz' })
  fireAt: Date;

  @Column({ type: 'enum', enum: NotificationChannel })
  channel: NotificationChannel;

  @Column({
    type: 'enum',
    enum: ScheduledNotificationStatus,
    default: ScheduledNotificationStatus.PENDING,
  })
  status: ScheduledNotificationStatus;

  @Column({ type: 'int', default: 0 })
  attemptCount: number;

  @Column({ type: 'timestamptz', nullable: true })
  sentAt: Date | null;

  @Column({ type: 'text', nullable: true })
  error: string | null;
}
