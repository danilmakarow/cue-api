import { Inject, Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';

import { statusSessionKey } from '../../redis/redis.constants';
import { REDIS_CLIENT } from '../../redis/redis.module';
import { AssistantConfig } from '../assistant.config';
import { ChatType } from '@/modules/external-vendor/external-vendor.types';

/**
 * Lifecycle phase of a live-status handle. The store owns only the state
 * transitions; Stories 12/13 drive the surface (cycling words, dots, streaming)
 * — this story does NOT animate anything.
 */
export enum StatusSessionPhase {
  /** Empty-text draft posted ("Thinking…"); awaiting the first real update. */
  Thinking = 'thinking',
  /**
   * Cycling a loading word + dots / per-round recap (Story 12). The terminal
   * phase: the answer is NOT streamed into the draft (ADR 0052), so the surface
   * stays in `Working` until the turn finalizes and the real reply supersedes it.
   */
  Working = 'working',
}

/**
 * Whether the status surface is a private-chat ephemeral DRAFT (the
 * `sendMessageDraft` primitive, keyed by `draftId`) or a non-private real
 * MESSAGE that the degraded path edits (`editMessageText`, keyed by
 * `vendorMessageId`). Set once at create time from the chat kind so every later
 * update targets the right primitive.
 */
export enum StatusSurfaceKind {
  Draft = 'draft',
  Message = 'message',
}

/**
 * The persisted live-status handle for one in-flight turn. Holds just enough to
 * re-target the animated surface idempotently: the surface kind + its identifier
 * (`draftId` for a private draft, `vendorMessageId` for the non-private edited
 * message), the chat + locale the animation needs, and the current phase.
 */
export interface StatusSession {
  vendorChatId: string;
  turnId: string;
  chatType: ChatType;
  surfaceKind: StatusSurfaceKind;
  /** Non-zero draft id when `surfaceKind === Draft`; else absent. */
  draftId?: number;
  /** Real vendor message id when `surfaceKind === Message`; else absent. */
  vendorMessageId?: string;
  locale: string;
  phase: StatusSessionPhase;
}

/**
 * Inputs needed to open a status session for a turn. `chatType` selects the
 * surface kind (private ⇒ draft, else ⇒ edited message); `seedDraftId` /
 * `seedVendorMessageId` provide the freshly-minted surface identifier the caller
 * already created (or will create) for this turn.
 */
export interface OpenStatusSessionInput {
  vendorChatId: string;
  turnId: string;
  chatType: ChatType;
  locale: string;
  /** The non-zero draft id to use for a private-chat draft surface. */
  seedDraftId?: number;
  /** The real message id to edit for a non-private surface. */
  seedVendorMessageId?: string;
}

/**
 * Redis-backed, IDEMPOTENT live-status handle store (L9, ADR 0012). Keyed per
 * chat + turn (`assistant:status:{chatId}:{turnId}`), it persists the
 * {@link StatusSession} for one turn so opening it twice for the SAME turn never
 * orphans a second draft/message — the second `open` re-reads and returns the
 * existing handle. This idempotency is what keeps the surface safe if the BullMQ
 * `attempts` is ever raised above 1 (a replayed job re-enters with the same
 * `turnId`).
 *
 * This story builds the STORE + lifecycle only. The animation (cycling words,
 * dots, streaming) lands in Stories 12/13, which read/advance this handle.
 *
 * See `docs/adr/0038-assistant-messenger-primitives-status-session.md`.
 */
@Injectable()
export class StatusSessionStore {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly config: AssistantConfig,
  ) {}

  /**
   * Selects the surface kind from the chat kind: a private chat gets the
   * ephemeral draft surface; anything else gets the real-message (edited) surface.
   */
  private surfaceKindFor(chatType: ChatType): StatusSurfaceKind {
    return chatType === ChatType.Private
      ? StatusSurfaceKind.Draft
      : StatusSurfaceKind.Message;
  }

  /**
   * Builds the session object a fresh `open` persists from its input + the chosen
   * surface kind. Carries only the identifier matching the surface kind.
   */
  private buildSession(
    input: OpenStatusSessionInput,
    surfaceKind: StatusSurfaceKind,
  ): StatusSession {
    return {
      vendorChatId: input.vendorChatId,
      turnId: input.turnId,
      chatType: input.chatType,
      surfaceKind,
      draftId:
        surfaceKind === StatusSurfaceKind.Draft ? input.seedDraftId : undefined,
      vendorMessageId:
        surfaceKind === StatusSurfaceKind.Message
          ? input.seedVendorMessageId
          : undefined,
      locale: input.locale,
      phase: StatusSessionPhase.Thinking,
    };
  }

  /**
   * Opens (or returns the existing) status session for a turn, IDEMPOTENTLY. Uses
   * Redis `SET NX` so the FIRST caller writes the handle and any concurrent /
   * replayed caller for the same `(chatId, turnId)` loses the race and reads back
   * the already-stored handle — never creating a second surface. Returns the live
   * handle either way; the caller compares `session.turnId`/identifiers to know
   * whether it must actually post the draft (won the race) or skip (reused).
   */
  async open(input: OpenStatusSessionInput): Promise<StatusSession> {
    const key = statusSessionKey(input.vendorChatId, input.turnId);
    const surfaceKind = this.surfaceKindFor(input.chatType);
    const session = this.buildSession(input, surfaceKind);

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
    // rather than orphaning a second draft/message.
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
   * Clears the status handle once the turn finalizes (the draft has been finalized
   * with a real `sendMessage`, or the edited message is now the final answer).
   * Idempotent — deleting an absent key is a harmless no-op. MUST be called in the
   * turn's `finally` so a crashed turn leaves no stale handle (and the short TTL is
   * the backstop if it is not).
   */
  async clear(vendorChatId: string, turnId: string): Promise<void> {
    await this.redis.del(statusSessionKey(vendorChatId, turnId));
  }
}
