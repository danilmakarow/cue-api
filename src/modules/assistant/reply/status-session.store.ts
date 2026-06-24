import { Inject, Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';

import { statusSessionKey } from '../../redis/redis.constants';
import { REDIS_CLIENT } from '../../redis/redis.module';
import { AssistantConfig } from '../assistant.config';
import { ChatType } from '@/modules/external-vendor/external-vendor.types';

/**
 * Lifecycle phase of a live-status handle. The store owns only the state
 * transitions; the animator (ADR 0053) drives the one real status message — this
 * store does not edit anything.
 */
export enum StatusSessionPhase {
  /** Initial loading line posted (e.g. "Thinking…"); awaiting the first real update. */
  Thinking = 'thinking',
  /**
   * Editing the one real status message in place with per-round recaps (ADR
   * 0053). The terminal live phase: the surface stays in `Working` until the turn
   * finalizes and the SAME message is edited one last time into the real reply
   * (the morph), so the user only ever sees one message.
   */
  Working = 'working',
}

/**
 * The persisted live-status handle for one in-flight turn (ADR 0059, reversing
 * 0053). The surface depends on the chat kind: a PRIVATE chat drives an ephemeral
 * Telegram draft (`sendMessageDraft`) keyed by a stable non-zero {@link draftId}
 * and has NO real status message until the turn finalizes; a NON-PRIVATE chat
 * keeps the ADR 0053 fallback — a single real message edited in place via
 * `editMessageText`, re-targeted by {@link vendorMessageId}. The handle carries
 * whichever pointer the surface uses, plus the chat + locale + current phase.
 */
export interface StatusSession {
  vendorChatId: string;
  turnId: string;
  chatType: ChatType;
  /**
   * Real vendor message id of the one per-turn status message (non-private
   * fallback, ADR 0053). Absent on a private/draft turn — there is no real status
   * message; the draft self-expires and the final answer is a fresh send.
   */
  vendorMessageId?: string;
  /**
   * Stable NON-ZERO draft id for the private-chat ephemeral draft surface (ADR
   * 0059). Re-sending `sendMessageDraft` with the same id animates the text diffs
   * natively. Absent on the non-private fallback (which has no draft).
   */
  draftId?: number;
  locale: string;
  phase: StatusSessionPhase;
}

/**
 * Inputs needed to open a status session for a turn. `seedVendorMessageId`
 * carries the real message id the caller created for a NON-PRIVATE turn's status
 * surface (absent until the initial send lands); `seedDraftId` carries the stable
 * non-zero draft id for a PRIVATE turn's ephemeral draft surface (ADR 0059).
 */
export interface OpenStatusSessionInput {
  vendorChatId: string;
  turnId: string;
  chatType: ChatType;
  locale: string;
  /** The real message id to edit for a non-private turn's status surface, when known. */
  seedVendorMessageId?: string;
  /** The stable non-zero draft id for a private turn's ephemeral draft surface (ADR 0059). */
  seedDraftId?: number;
}

/**
 * Redis-backed, IDEMPOTENT live-status handle store (L9, ADR 0012). Keyed per
 * chat + turn (`assistant:status:{chatId}:{turnId}`), it persists the
 * {@link StatusSession} for one turn so opening it twice for the SAME turn never
 * orphans a second status message — the second `open` re-reads and returns the
 * existing handle. This idempotency is what keeps the surface safe if the BullMQ
 * `attempts` is ever raised above 1 (a replayed job re-enters with the same
 * `turnId`).
 *
 * The store owns the handle + lifecycle only; the animator (ADR 0053) posts and
 * edits the one real status message that this handle points at.
 *
 * See `docs/adr/0053-telegram-status-message-morph.md`.
 */
@Injectable()
export class StatusSessionStore {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly config: AssistantConfig,
  ) {}

  /**
   * Builds the session object a fresh `open` persists from its input. It carries
   * whichever surface pointer the chat kind uses (ADR 0059): the seed `draftId`
   * for a private/draft turn, or the seed `vendorMessageId` for the non-private
   * `editMessageText` fallback — whichever the caller supplied.
   */
  private buildSession(input: OpenStatusSessionInput): StatusSession {
    return {
      vendorChatId: input.vendorChatId,
      turnId: input.turnId,
      chatType: input.chatType,
      vendorMessageId: input.seedVendorMessageId,
      draftId: input.seedDraftId,
      locale: input.locale,
      phase: StatusSessionPhase.Thinking,
    };
  }

  /**
   * Opens (or returns the existing) status session for a turn, IDEMPOTENTLY. Uses
   * Redis `SET NX` so the FIRST caller writes the handle and any concurrent /
   * replayed caller for the same `(chatId, turnId)` loses the race and reads back
   * the already-stored handle — never creating a second surface. Returns the live
   * handle either way; the caller checks `session.vendorMessageId` to know whether
   * it must post the status message (none yet) or reuse the existing one.
   */
  async open(input: OpenStatusSessionInput): Promise<StatusSession> {
    const key = statusSessionKey(input.vendorChatId, input.turnId);
    const session = this.buildSession(input);

    const stored = await this.redis.set(
      key,
      JSON.stringify(session),
      'EX',
      this.config.statusSessionTtlSeconds,
      'NX',
    );

    if (stored === 'OK') {
      return session;
    }

    // Lost the NX race (concurrent or replayed open) — return the existing handle
    // rather than orphaning a second status message.
    const existing = await this.get(input.vendorChatId, input.turnId);

    return existing ?? session;
  }

  /**
   * Reads the current status session for a chat + turn, or null when none is open
   * (never created, or already cleared / TTL'd out).
   */
  async get(
    vendorChatId: string,
    turnId: string,
  ): Promise<StatusSession | null> {
    const raw = await this.redis.get(statusSessionKey(vendorChatId, turnId));

    if (!raw) {
      return null;
    }

    return JSON.parse(raw) as StatusSession;
  }

  /**
   * Advances the session's phase in place (Thinking → Working), refreshing the
   * TTL. No-op returning null when the session is gone. The phase label is what
   * Story 12's animation keys off; the transition is owned here so the lifecycle
   * stays in one place.
   */
  async advancePhase(
    vendorChatId: string,
    turnId: string,
    phase: StatusSessionPhase,
  ): Promise<StatusSession | null> {
    const session = await this.get(vendorChatId, turnId);

    if (!session) {
      return null;
    }

    session.phase = phase;

    await this.redis.set(
      statusSessionKey(vendorChatId, turnId),
      JSON.stringify(session),
      'EX',
      this.config.statusSessionTtlSeconds,
    );

    return session;
  }

  /**
   * Clears the status handle once the turn finalizes (by which point the reply has
   * morphed the one status message into the final answer). Idempotent — deleting an
   * absent key is a harmless no-op. MUST be called in the turn's `finally` so a
   * crashed turn leaves no stale handle (and the short TTL is the backstop if it is
   * not).
   */
  async clear(vendorChatId: string, turnId: string): Promise<void> {
    await this.redis.del(statusSessionKey(vendorChatId, turnId));
  }
}
