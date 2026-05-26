import { Column, Entity, JoinColumn, ManyToOne, OneToMany } from 'typeorm';

import { BaseEntity } from './base.entity';
import { Calendar } from './calendar.entity';
import { NotificationRule } from './notification-rule.entity';

/**
 * NotificationStrategy entity representing a named bundle of notification rules.
 * Tasks and task groups reference strategies to determine when and how to notify.
 */
@Entity()
export class NotificationStrategy extends BaseEntity {
  @Column()
  calendarId: string;

  @ManyToOne(() => Calendar, (calendar) => calendar.notificationStrategies, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'calendarId' })
  calendar: Calendar;

  @Column()
  name: string;

  @OneToMany(() => NotificationRule, (rule) => rule.strategy)
  rules: NotificationRule[];
}
