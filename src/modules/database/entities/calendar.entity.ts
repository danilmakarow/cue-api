import { ApiProperty } from '@nestjs/swagger';
import { Column, Entity, JoinColumn, ManyToOne, OneToMany } from 'typeorm';

import { BaseEntity } from './base.entity';
import { NotificationStrategy } from './notification-strategy.entity';
import { TaskGroup } from './task-group.entity';
import { Task } from './task.entity';
import { User } from './user.entity';

/**
 * Calendar entity representing the organizational unit that owns tasks, task groups,
 * and notification strategies. Each calendar belongs to exactly one user today;
 * sharing / membership is out of scope for now.
 */
@Entity()
export class Calendar extends BaseEntity {
  @ApiProperty({ format: 'uuid', description: 'Owning user id.' })
  @Column()
  ownerId: string;

  @ManyToOne(() => User, (user) => user.calendars, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'ownerId' })
  owner: User;

  @ApiProperty({ example: 'Work' })
  @Column()
  name: string;

  @ApiProperty({ nullable: true, example: '#E27921' })
  @Column({ type: String, nullable: true })
  color: string | null;

  @ApiProperty({ nullable: true, example: 'briefcase.fill' })
  @Column({ type: String, nullable: true })
  icon: string | null;

  @ApiProperty({ example: 0 })
  @Column({ type: 'int', default: 0 })
  sortOrder: number;

  @OneToMany(() => TaskGroup, (taskGroup) => taskGroup.calendar)
  taskGroups: TaskGroup[];

  @OneToMany(() => Task, (task) => task.calendar)
  tasks: Task[];

  @OneToMany(
    () => NotificationStrategy,
    (notificationStrategy) => notificationStrategy.calendar,
  )
  notificationStrategies: NotificationStrategy[];
}
