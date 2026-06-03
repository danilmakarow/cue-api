import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';

import { BaseEntity } from './base.entity';
import { Conversation } from './conversation.entity';

/**
 * ConversationSummary entity — a recursive rolling summary of everything older
 * than the live window (ADR 0005 tier 2). History is kept; the latest row is
 * pointed to by `Conversation.latestSummaryId`. Indexed on (conversationId,
 * createdAt) to fetch the newest summary cheaply.
 */
@Entity()
@Index(['conversationId', 'createdAt'])
export class ConversationSummary extends BaseEntity {
  @Column()
  conversationId: string;

  @ManyToOne(() => Conversation, (conversation) => conversation.summaries, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'conversationId' })
  conversation: Conversation;

  @Column({ type: 'text' })
  summaryText: string;

  /**
   * The id of the newest {@link ConversationMessage} folded into this summary.
   * Everything up to and including it is covered; newer messages stay verbatim.
   */
  @Column({ type: 'uuid' })
  coversUpToMessageId: string;

  /**
   * Best-effort token count of `summaryText`, used to bound prompt block 4.
   */
  @Column({ type: 'int', nullable: true })
  tokenCount: number | null;
}
