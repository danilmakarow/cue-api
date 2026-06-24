import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';

import { BaseEntity } from './base.entity';
import { Conversation } from './conversation.entity';
import { ToolRound } from '@/modules/ai/ai.types';

/**
 * Lifecycle status of an `ask_user` pending question (ADR 0010). A row starts
 * `AWAITING` (the turn is suspended, the model is waiting on the user); the
 * atomic claim flips it to `ANSWERED` exactly once on resume; `CANCELLED` covers
 * a superseding turn or an explicit dismissal; `EXPIRED` is set by the cleanup
 * job once the row passes its `expiresAt`/retention horizon without an answer.
 */
export enum PendingQuestionStatus {
  AWAITING = 'AWAITING',
  ANSWERED = 'ANSWERED',
  CANCELLED = 'CANCELLED',
  EXPIRED = 'EXPIRED',
}

/**
 * One tappable quick-reply offered alongside an `ask_user` question. `id` is the
 * stable option key echoed back on the inline-keyboard callback (`ask:<row>:<id>`);
 * `label` is the human-facing button text. Capped at four options by the tool
 * schema (ADR 0010) — not enforced at the column level since the payload is jsonb.
 */
export interface PendingQuestionOption {
  id: string;
  label: string;
}

/**
 * The durably-persisted suspended session for a single `ask_user` turn (ADR 0010,
 * the system of record mirrored to Redis with a TTL). On the user's answer this
 * is rehydrated, the `ask_user` `tool_result` is synthesized against
 * {@link askToolUseId}, and the tool loop is re-entered so the model continues.
 *
 * `toolRounds` are the accumulated rounds of the in-flight turn, INCLUDING the
 * assistant round that carries the `ask_user` `tool_use` but deliberately NOT its
 * `tool_result` (that one block is appended on resume — the wire invariant in
 * ADR 0010). No `any`: the rounds reuse the canonical {@link ToolRound} contract
 * the orchestrator already speaks, so the persisted shape cannot drift from it.
 */
export interface PendingQuestionPayload {
  /**
   * The accumulated tool-loop rounds of the suspended turn, in order, including
   * the assistant round carrying the `ask_user` `tool_use` (its `tool_result` is
   * intentionally absent — supplied on resume).
   */
  toolRounds: ToolRound[];
  /** The question text the model asked the user. */
  question: string;
  /**
   * Map of option id → button label for the offered quick-replies (omitted /
   * empty for a plain free-text question).
   */
  optionLabels: PendingQuestionOption[];
  /** Correlation id of the originating turn, carried for log stitching on resume. */
  correlationId: string;
  /** Vendor (Telegram) chat id the resumed reply must be delivered back to. */
  vendorChatId: string;
  /**
   * Vendor message id of the QUESTION message the `ask_user` keyboard was sent on
   * (R3 / ADR 0058) — captured by the orchestrator after the question is sent so
   * the resume can morph that original message (remove its buttons + append the
   * chosen answer) on a button tap. jsonb, so it is purely additive (no migration);
   * ABSENT on rows suspended before R3 — the resume skips the question-morph edit
   * gracefully when it is missing.
   */
  questionVendorMessageId?: string;
}

/**
 * PendingQuestion entity — the durable store for a suspended `ask_user` turn
 * (ADR 0010). One open (`AWAITING`) row per conversation at a time, enforced by a
 * partial unique index on `conversationId WHERE status = 'AWAITING'`. The
 * `(status, expiresAt)` index serves the `@nestjs/schedule` cleanup sweep. The FK
 * cascades from `Conversation` so deleting a thread reaps its pending questions.
 */
@Entity()
@Index(['status', 'expiresAt'])
export class PendingQuestion extends BaseEntity {
  @Column()
  conversationId: string;

  @ManyToOne(() => Conversation, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'conversationId' })
  conversation: Conversation;

  /**
   * The `tool_use` id of the `ask_user` call this row suspends on. On resume the
   * synthesized `tool_result` is paired to exactly this id (the ADR 0010 wire
   * invariant — never an interleaved/unpaired block).
   */
  @Column({ type: 'text' })
  askToolUseId: string;

  /**
   * The suspended session (jsonb): the in-flight `toolRounds`, the question, the
   * option→label map, and the correlation/chat ids needed to resume and reply.
   */
  @Column({ type: 'jsonb' })
  payload: PendingQuestionPayload;

  @Column({
    type: 'enum',
    enum: PendingQuestionStatus,
    default: PendingQuestionStatus.AWAITING,
  })
  status: PendingQuestionStatus;

  /**
   * When the hot (Redis-mirrored) answer window lapses. Past this the row is
   * resumable only via a button (carrying the row id) up to the hard retention
   * horizon; the cleanup job uses it together with `status` to expire stale rows.
   */
  @Column({ type: 'timestamptz' })
  expiresAt: Date;
}
