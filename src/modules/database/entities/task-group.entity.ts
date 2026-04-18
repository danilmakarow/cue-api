import { Column, Entity, JoinColumn, ManyToOne, OneToMany } from 'typeorm';

import { BaseEntity } from './base.entity';
import { NotificationStrategy } from './notification-strategy.entity';
import { Task } from './task.entity';
import { User } from './user.entity';

/**
 * TaskGroup entity representing a user-defined bucket of tasks (e.g. "Work", "Home").
 * Groups optionally carry a default notification strategy inherited by contained tasks.
 */
@Entity()
export class TaskGroup extends BaseEntity {
  @Column()
  userId: string;

  @ManyToOne(() => User, (user) => user.taskGroups, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

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

  @Column({ type: 'int', default: 0 })
  sortOrder: number;

  @OneToMany(() => Task, (task) => task.group)
  tasks: Task[];
}
