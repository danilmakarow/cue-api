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
import { Calendar } from './calendar.entity';
import { NotificationStrategy } from './notification-strategy.entity';
import { TaskGroup } from './task-group.entity';
import { TaskOccurrenceException } from './task-occurrence-exception.entity';
import type { RecurrenceConfig } from '@/modules/recurrence-rule/recurrence.types';

/**
 * Task entity — the unified event+todo primitive for Cue.
 * Supports all-day and timed occurrences, optional recurrence, per-task timezone, and soft deletion.
 * Indexed on (calendarId, startAt) to serve calendar and agenda queries efficiently.
 */
@Entity()
@Index(['calendarId', 'startAt'])
export class Task extends BaseEntity {
  @Column()
  calendarId: string;

  @ManyToOne(() => Calendar, (calendar) => calendar.tasks, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'calendarId' })
  calendar: Calendar;

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

  /**
   * Per-task completion requirement. Nullable: when null the effective value is
   * resolved task-wins as `task.requiresCompletion ?? group.requiresCompletion ??
   * false` (the default lives in the resolver, NOT as a column default).
   */
  @Column({ type: 'boolean', nullable: true })
  requiresCompletion: boolean | null;

  /**
   * Display color: a {@link TaskColor} preset name OR a custom `#RRGGBB` hex.
   * Null inherits the group color via the effective-settings resolver.
   */
  @Column({ type: 'varchar', nullable: true })
  color: string | null;

  /**
   * Optional per-task icon (an SF Symbol name, e.g. `cart.fill`). Mirrors the
   * `icon` columns on {@link Calendar} and {@link TaskGroup}. Null leaves the
   * task iconless (the client may fall back to a group/default icon).
   */
  @Column({ type: 'varchar', nullable: true })
  icon: string | null;

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

  /**
   * Inline recurrence configuration (JSONB), or null for a non-recurring task.
   * Replaces the former `recurrenceRuleId` FK + `recurrenceRule` relation — the
   * rule now lives on the row itself (ADR 0054).
   */
  @Column({ type: 'jsonb', nullable: true })
  recurrenceConfig: RecurrenceConfig | null;

  /**
   * When set, this row is a materialized OVERRIDE of a single occurrence of the
   * recurring parent task named here (the iCalendar RECURRENCE-ID pattern). A
   * child is a first-class one-off task (`recurrenceConfig` must be null) that
   * replaces the generated occurrence at {@link originalStartAt}. `ON DELETE SET
   * NULL` is a hard-delete safety net only — the real "parent deleted" semantics
   * are an app-level cascade soft-delete; a hard delete (e.g. a calendar CASCADE)
   * degrades the child to a standalone task rather than destroying it.
   */
  @Column({ type: 'uuid', nullable: true })
  parentTaskId: string | null;

  @ManyToOne(() => Task, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'parentTaskId' })
  parentTask: Task | null;

  /**
   * RECURRENCE-ID: the rule-generated UTC instant this override replaces, BEFORE
   * any edit. Immutable after creation; identifies which generated occurrence of
   * the parent this child suppresses. Non-null iff `parentTaskId` is non-null
   * (enforced by a DB CHECK); may linger as inert residue if the row is later
   * orphaned (parentTaskId nulled by the FK safety net).
   */
  @Column({ type: 'timestamptz', nullable: true })
  originalStartAt: Date | null;

  /**
   * Set when the parent's effective rule no longer generates {@link
   * originalStartAt} (a rule / anchor edit rekeyed the series). A detached child
   * keeps rendering at its own `startAt` and stays linked for provenance, but
   * suppresses nothing. Cleared if a later rule edit regenerates its slot.
   */
  @Column({ type: 'timestamptz', nullable: true })
  detachedAt: Date | null;

  /**
   * Bumped only when the task's effective-rule INPUT set changes (own
   * `recurrenceConfig`, `startAt`, `timezone`, `isAllDay`, `groupId`, or a
   * group-side rule change/delete) — never by completion/skip parent-touches.
   * The iOS delta client uses `recurrenceUpdatedAt > since` as its "re-expansion
   * needed" discriminator, invalidating all cached month windows for the
   * calendar when it moves.
   */
  @Column({ type: 'timestamptz', nullable: true })
  recurrenceUpdatedAt: Date | null;

  @DeleteDateColumn({ type: 'timestamptz' })
  deletedAt: Date | null;

  @OneToMany(() => TaskOccurrenceException, (exception) => exception.task)
  occurrenceExceptions: TaskOccurrenceException[];
}
