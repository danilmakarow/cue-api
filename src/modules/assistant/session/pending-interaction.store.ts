import { Inject, Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';

import { pendingQuestionKey } from '../../redis/redis.constants';
import { REDIS_CLIENT } from '../../redis/redis.module';
import { AssistantConfig } from '../assistant.config';
import {
  PendingQuestion,
  PendingQuestionPayload,
} from '@/modules/database/entities';
import { PendingQuestionDatabaseService } from '@/modules/database/services';

/**
 * Read port for a suspended `ask_user` question's hot pointer. The inbound router
 * depends on this narrow interface (not the Redis client) so the 4-flow
 * classification can be unit-tested with a trivial stub, and so the write side
 * (Story 5: suspend an `ask_user` turn, set the key, persist the durable
 * `pending_question` row) is added behind the same port without touching the
 * router.
 */
export interface PendingInteractionStore {
  /**
   * Whether the given user currently has an open `ask_user` question awaiting a
   * free-text answer (cheap Redis `EXISTS` on the hot pointer). True only while
   * the hot window (TTL `ASSISTANT_ASK_USER_TTL_SECONDS`) is live — after it
   * lapses a typed message is a fresh turn (a button still resumes from Postgres).
   */
  hasPendingQuestion(userId: string): Promise<boolean>;
}

/** DI token for the {@link PendingInteractionStore} read port. */
export const PENDING_INTERACTION_STORE = Symbol('PENDING_INTERACTION_STORE');

/**
 * The session a suspended `ask_user` turn persists (ADR 0010): the durable
 * payload (in-flight `toolRounds` minus the ask `tool_result`, the question, the
 * option→label map, and the correlation/chat ids), the `ask_user` `tool_use` id
 * the resume pairs its synthetic result to, and the conversation the open row
 * hangs off. Built by the orchestrator on suspend and handed to
 * {@link PendingInteractionService.createPendingQuestion}.
 */
export interface PendingQuestionDraft {
  conversationId: string;
  askToolUseId: string;
  payload: PendingQuestionPayload;
}

/**
 * The full pending-`ask_user` interaction service (ADR 0010) — the WRITE side
 * behind the read port. It owns BOTH stores: the durable `pending_question` row
 * (system of record, via the 3-layer {@link PendingQuestionDatabaseService}) and
 * the hot Redis mirror (the free-text answer window). `hasPendingQuestion` stays
 * the cheap Redis `EXISTS` the router calls; `createPendingQuestion` writes the
 * row then mirrors it; the two claim paths are the idempotent ADR-0010 resume
 * gate — `claimHotByUser` (`GETDEL` the key, then claim that row in Postgres) for
 * a free-text answer, and `claimById` (claim the row directly, then best-effort
 * clear the hot key) for a button tap that may arrive after the TTL.
 */
@Injectable()
export class PendingInteractionService implements PendingInteractionStore {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly config: AssistantConfig,
    private readonly pendingQuestionDatabaseService: PendingQuestionDatabaseService,
  ) {}

  /**
   * Returns whether a hot pending-question pointer exists for the user via a
   * cheap `EXISTS`. False once the hot window lapses (the key TTL'd out) even if
   * the durable row is still resumable by a button.
   */
  async hasPendingQuestion(userId: string): Promise<boolean> {
    const exists = await this.redis.exists(pendingQuestionKey(userId));

    return exists > 0;
  }

  /**
   * Suspends an `ask_user` turn: writes the durable `pending_question` row
   * (status `AWAITING`, `expiresAt = now + ASSISTANT_ASK_USER_RETENTION_HOURS`)
   * via the 3-layer DB service, then mirrors a hot pointer to Redis keyed by the
   * user id (value = the row id, TTL `ASSISTANT_ASK_USER_TTL_SECONDS`) so the
   * free-text answer gate (`EXISTS`) and resolve (`GETDEL` → row id) work. The
   * partial unique index guarantees at most one open row per conversation. Returns
   * the persisted row so the caller can build the button callback data
   * (`ask:<row.id>:<optId>`).
   */
  async createPendingQuestion(
    userId: string,
    draft: PendingQuestionDraft,
  ): Promise<PendingQuestion> {
    const expiresAt = new Date(
      Date.now() + this.config.askUserRetentionHours * 3_600_000,
    );
    const row = this.pendingQuestionDatabaseService.createInstance({
      conversationId: draft.conversationId,
      askToolUseId: draft.askToolUseId,
      payload: draft.payload,
      expiresAt,
    });
    const saved = await this.pendingQuestionDatabaseService.save(row);

    await this.redis.set(
      pendingQuestionKey(userId),
      saved.id,
      'EX',
      this.config.askUserTtlSeconds,
    );

    return saved;
  }

  /**
   * Atomically claims the user's open question for a FREE-TEXT answer inside the
   * hot window: `GETDEL` the hot key (so a racing inbound update cannot also win
   * it), then compare-and-set the named row `AWAITING → ANSWERED`. Returns the
   * claimed row, or null when there was no hot key (window lapsed) or the row was
   * already claimed — the caller MUST treat null as "already answered / not for
   * us" and not double-resume.
   */
  async claimHotByUser(userId: string): Promise<PendingQuestion | null> {
    const rowId = await this.redis.getdel(pendingQuestionKey(userId));

    if (!rowId) {
      return null;
    }

    return this.pendingQuestionDatabaseService.claimAwaiting(rowId);
  }

  /**
   * Atomically claims a specific question by row id for a BUTTON answer: the
   * durable compare-and-set is the authority (`AWAITING → ANSWERED` RETURNING),
   * so a tap resumes from Postgres even days later, after the Redis TTL and a
   * restart. On a winning claim the hot key (if still present) is best-effort
   * cleared so a stale free-text gate cannot also fire. Returns null when the row
   * was already claimed / never existed — the caller ignores it gracefully.
   */
  async claimById(
    userId: string,
    pendingQuestionId: string,
  ): Promise<PendingQuestion | null> {
    const claimed =
      await this.pendingQuestionDatabaseService.claimAwaiting(
        pendingQuestionId,
      );

    if (!claimed) {
      return null;
    }

    await this.redis.del(pendingQuestionKey(userId));

    return claimed;
  }
}
