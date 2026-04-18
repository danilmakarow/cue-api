import { Column, Entity, OneToMany } from 'typeorm';

import { BaseEntity } from './base.entity';
import { Device } from './device.entity';
import { NotificationStrategy } from './notification-strategy.entity';
import { TaskGroup } from './task-group.entity';
import { Task } from './task.entity';
import { TelegramLink } from './telegram-link.entity';

/**
 * User entity representing an authenticated Cue user.
 * The appleUserId column holds Apple's `sub` claim from Sign in with Apple.
 */
@Entity()
export class User extends BaseEntity {
  @Column({ unique: true })
  appleUserId: string;

  @Column({ type: String, nullable: true })
  email: string | null;

  @Column({ type: String, nullable: true })
  displayName: string | null;

  @Column({ default: 'UTC' })
  timezone: string;

  @OneToMany(() => Device, (device) => device.user)
  devices: Device[];

  @OneToMany(() => TelegramLink, (telegramLink) => telegramLink.user)
  telegramLinks: TelegramLink[];

  @OneToMany(() => TaskGroup, (taskGroup) => taskGroup.user)
  taskGroups: TaskGroup[];

  @OneToMany(() => Task, (task) => task.user)
  tasks: Task[];

  @OneToMany(
    () => NotificationStrategy,
    (notificationStrategy) => notificationStrategy.user,
  )
  notificationStrategies: NotificationStrategy[];
}
