import { Column, Entity, JoinColumn, OneToOne } from 'typeorm';

import { BaseEntity } from './base.entity';
import { User } from './user.entity';

/**
 * UserSyncState entity — the per-user monotonic sync revision that backs the
 * cheap `GET /sync/state` "did anything change since X?" check. One row per User
 * (the unique `userId` enforces the 1:1, mirroring {@link UserReportSettings}).
 *
 * `revision` is an opaque, strictly monotonic counter bumped by every task /
 * group / calendar mutation (REST and the Telegram assistant alike, since both
 * funnel through the same feature services). Clients compare it for EQUALITY
 * only: `revision != lastSeen` ⇒ pull the delta; equal ⇒ skip. It is never
 * interpreted as a count, so a double-bump within one request is harmless.
 *
 * Stored as `bigint`, which TypeORM surfaces as a string in JS — matching how it
 * is serialized on the wire.
 */
@Entity()
export class UserSyncState extends BaseEntity {
  @Column({ unique: true })
  userId: string;

  @OneToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  /**
   * Strictly monotonic per-user revision, incremented atomically on every
   * bump-carrying mutation. `bigint` ⇒ string in JS. Starts at `0`; the first
   * bump makes it `1`.
   */
  @Column({ type: 'bigint', default: 0 })
  revision: string;

  /**
   * Server timestamp of the most recent bump. Advisory only (clients gate on
   * `revision`); useful for debugging and a future `If-Modified-Since` path.
   */
  @Column({ type: 'timestamptz', default: () => 'now()' })
  changedAt: Date;
}
