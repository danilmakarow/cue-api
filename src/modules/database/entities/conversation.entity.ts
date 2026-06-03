import { Column, Entity, JoinColumn, OneToMany, OneToOne } from 'typeorm';

import { BaseEntity } from './base.entity';
import { ConversationMessage } from './conversation-message.entity';
import { ConversationSummary } from './conversation-summary.entity';
import { User } from './user.entity';

/**
 * Conversation entity — the single perpetual assistant thread per user.
 * One-to-one with User; holds the last-activity marker and a pointer to the
 * latest rolling summary. See ADR 0005 (conversation memory model).
 */
@Entity()
export class Conversation extends BaseEntity {
  @Column({ unique: true })
  userId: string;

  @OneToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  /**
   * Timestamp of the most recent message in this conversation, updated on every
   * inbound and outbound turn so idle/active windows can be reasoned about.
   */
  @Column({ type: 'timestamptz', nullable: true })
  lastActivityAt: Date | null;

  /**
   * Points to the most recent {@link ConversationSummary} (the one injected as
   * prompt block 4). Nullable until the first summary is produced. Kept as a
   * plain id column with no FK constraint to avoid a circular cascade between
   * conversation and its summaries.
   */
  @Column({ type: 'uuid', nullable: true })
  latestSummaryId: string | null;

  @OneToMany(() => ConversationMessage, (message) => message.conversation)
  messages: ConversationMessage[];

  @OneToMany(() => ConversationSummary, (summary) => summary.conversation)
  summaries: ConversationSummary[];
}
