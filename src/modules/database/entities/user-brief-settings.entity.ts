import { Column, Entity, Index, JoinColumn, OneToOne } from 'typeorm';

import { BaseEntity } from './base.entity';
import { User } from './user.entity';

/**
 * UserBriefSettings entity — the per-user personalization of the daily brief. One
 * row per User (the unique `userId` enforces the 1:1). `customPrompt` is an
 * optional, user-authored instruction appended to the base daily-brief system
 * prompt (it AUGMENTS, never replaces, the base structure/safety/format rules);
 * null means the user has set nothing and the base prompt is used as-is.
 *
 * This is a settings row, not the brief content — the generated brief itself is
 * cached in Redis (see `DailyBriefCacheStore`), and a `customPrompt` change
 * invalidates today's cached brief so the new preference takes effect at once.
 */
@Entity()
@Index(['userId'], { unique: true })
export class UserBriefSettings extends BaseEntity {
  @Column({ type: 'uuid', unique: true })
  userId: string;

  @OneToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  /**
   * The user's own instruction appended to the base daily-brief system prompt as
   * an additional "User preferences for the briefing:" section. Null when unset
   * (the base prompt is used verbatim). Trimmed + length-bounded by the PATCH DTO
   * before it ever lands here; an empty payload clears it back to null.
   */
  @Column({ type: 'text', nullable: true })
  customPrompt: string | null;
}
