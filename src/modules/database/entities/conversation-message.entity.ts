import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';

import { BaseEntity } from './base.entity';
import { Conversation } from './conversation.entity';

/**
 * Author/role of a {@link ConversationMessage}, normalized across the pipeline.
 * `synthetic` is a system-generated summary line (e.g. a slash-command result)
 * that keeps the model aware of out-of-band actions without an LLM call.
 */
export enum ConversationMessageRole {
  USER = 'user',
  ASSISTANT = 'assistant',
  TOOL = 'tool',
  SYNTHETIC = 'synthetic',
}

/**
 * How the message content was produced, so the context builder and analytics can
 * distinguish a typed message from a transcribed voice note or a command result.
 */
export enum ConversationMessageContentType {
  TEXT = 'text',
  VOICE_TRANSCRIPT = 'voice_transcript',
  COMMAND_RESULT = 'command_result',
}

/**
 * ConversationMessage entity — one turn in the perpetual conversation. Many per
 * Conversation; the recent window (ADR 0005 tier 1) is read verbatim from the
 * latest rows. Indexed on (conversationId, createdAt) for the window query.
 */
@Entity()
@Index(['conversationId', 'createdAt'])
export class ConversationMessage extends BaseEntity {
  @Column()
  conversationId: string;

  @ManyToOne(() => Conversation, (conversation) => conversation.messages, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'conversationId' })
  conversation: Conversation;

  @Column({ type: 'enum', enum: ConversationMessageRole })
  role: ConversationMessageRole;

  @Column({
    type: 'enum',
    enum: ConversationMessageContentType,
    default: ConversationMessageContentType.TEXT,
  })
  contentType: ConversationMessageContentType;

  @Column({ type: 'text' })
  content: string;

  /**
   * Structured payload for tool turns (the tool calls a turn issued, or a tool
   * result), kept out of `content` so the verbatim window stays human-readable.
   */
  @Column({ type: 'jsonb', nullable: true })
  toolPayload: Record<string, unknown> | null;

  /**
   * Vendor message id this turn corresponds to (string form, per the
   * bigint-as-string convention). Used for tracing/dedupe; nullable because
   * synthetic and assistant turns may not map to a single vendor message.
   */
  @Column({ type: 'bigint', nullable: true })
  vendorMessageId: string | null;

  /**
   * Best-effort token count for this turn, surfaced from the AI connector usage
   * so the rolling-summary threshold and cost views can be computed.
   */
  @Column({ type: 'int', nullable: true })
  tokenCount: number | null;
}
