import { Column, Entity, JoinColumn, ManyToOne, Unique } from 'typeorm';

import { BaseEntity } from './base.entity';
import { Task } from './task.entity';

/**
 * TaskOccurrenceException entity capturing per-occurrence overrides on a recurring task.
 * Each row identifies a specific instance via originalStartAt and may skip it,
 * reschedule it, rename it, or record its completion.
 */
@Entity()
@Unique(['taskId', 'originalStartAt'])
export class TaskOccurrenceException extends BaseEntity {
  @Column()
  taskId: string;

  @ManyToOne(() => Task, (task) => task.occurrenceExceptions, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'taskId' })
  task: Task;

  /**
   * The original (un-overridden) start timestamp of the occurrence this exception applies to.
   * Acts as the stable identifier for a specific instance of a recurring task.
   */
  @Column({ type: 'timestamptz' })
  originalStartAt: Date;

  @Column({ default: false })
  isSkipped: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  overrideStartAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  overrideEndAt: Date | null;

  @Column({ type: String, nullable: true })
  overrideTitle: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  completedAt: Date | null;
}
