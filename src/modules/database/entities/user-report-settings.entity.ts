import { Column, Entity, Index, JoinColumn, OneToOne } from 'typeorm';

import { BaseEntity } from './base.entity';
import { NotificationChannel } from './notification-rule.entity';
import { User } from './user.entity';

/**
 * UserReportSettings entity (Story 17 / ADR 0046) — the per-user opt-in and
 * schedule for the daily notification report. One row per User (the unique
 * `userId` enforces the 1:1). The per-minute scheduler reads `enabled` +
 * `reportTimeLocal` to decide when to generate a report, and writes
 * `lastSentLocalDate` to make the send idempotent within a user's local day.
 *
 * Time-of-day is stored as a wall-clock `HH:mm` string interpreted in the user's
 * `User.timezone` (NOT a `timestamptz`) — the report fires at a local wall-clock
 * minute regardless of DST or where the user currently is, mirroring the
 * task-`timezone` discipline. `lastSentLocalDate` is the local `YYYY-MM-DD` the
 * last report was sent for; comparing it to the user's current local date is the
 * single double-send guard.
 */
@Entity()
@Index(['enabled'])
export class UserReportSettings extends BaseEntity {
  @Column({ unique: true })
  userId: string;

  @OneToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  /**
   * Whether the daily report is switched on. The per-minute scan filters on this
   * (`@Index(['enabled'])`) so an opted-out user is never considered. Defaults to
   * off — a freshly created default row sends nothing until the user opts in.
   */
  @Column({ default: false })
  enabled: boolean;

  /**
   * Local wall-clock send time as `HH:mm` (24-hour, zero-padded), interpreted in
   * the user's `User.timezone`. Defaults to `08:00`. The scheduler compares this
   * to the user's current local `HH:mm` to the minute.
   */
  @Column({ type: 'varchar', length: 5, default: '08:00' })
  reportTimeLocal: string;

  /**
   * Preferred delivery channel for the daily report (S7). Reuses the shared
   * {@link NotificationChannel} enum (`PUSH` | `TELEGRAM`). Defaults to
   * `TELEGRAM`. NOTE: push delivery is deferred (backlog D1) — a `PUSH` value
   * persists but does NOT deliver today; only Telegram is wired, so the scheduler
   * still sends via the Telegram sender regardless of this field until D1 ships.
   */
  @Column({
    type: 'enum',
    enum: NotificationChannel,
    default: NotificationChannel.TELEGRAM,
  })
  channel: NotificationChannel;

  /**
   * The user's local date (`YYYY-MM-DD`, in their timezone) the most recent
   * report was sent for, or null when none has ever been sent. Set atomically
   * before/with the send so a second scan in the same local minute (or any later
   * minute of the same local day) sees the day already covered and skips — the
   * idempotency guard against a double-send.
   */
  @Column({ type: String, nullable: true })
  lastSentLocalDate: string | null;
}
