import { Column, Entity, JoinColumn, ManyToOne, OneToMany } from 'typeorm';

import { BaseEntity } from './base.entity';
import { NotificationRule } from './notification-rule.entity';
import { User } from './user.entity';

/**
 * NotificationStrategy entity representing a named bundle of notification rules.
 * Tasks and task groups reference strategies to determine when and how to notify.
 */
@Entity()
export class NotificationStrategy extends BaseEntity {
  @Column()
  userId: string;

  @ManyToOne(() => User, (user) => user.notificationStrategies, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column()
  name: string;

  @OneToMany(() => NotificationRule, (rule) => rule.strategy)
  rules: NotificationRule[];
}
