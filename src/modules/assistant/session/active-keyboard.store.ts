import { Inject, Injectable, Logger } from '@nestjs/common';
import { Redis } from 'ioredis';

import { activeKeyboardKey } from '../../redis/redis.constants';
import { REDIS_CLIENT } from '../../redis/redis.module';
import { AssistantConfig } from '../assistant.config';
import {
  KeyboardSurface,
  toKeyboardSurface,
} from '../reply/reply-keyboard.layout';

/**
 * Read port for the active reply-keyboard surface (Story 16 / ADR 0045). The
 * inbound router depends on this narrow interface (not the Redis client) so the
 * keyboard-action classification stays purely unit-testable with a trivial stub —
 * exactly like {@link PendingInteractionStore} for the `ask_user` gate. The
 * router asks ONLY "which keyboard, if any, is the active surface for this user?"
 * and uses the answer to decide whether a plain-text message equal to a known
 * button label is a keyboard tap or ordinary conversation.
 */
export interface ActiveKeyboardReadPort {
  /**
   * Returns the keyboard surface currently docked for the user ({@link
   * KeyboardSurface.Main} / {@link KeyboardSurface.Settings}), or null when no
   * keyboard is the active surface. Null is the safe default — a typed label is
   * then never hijacked as a keyboard action.
   */
  getActiveSurface(userId: string): Promise<KeyboardSurface | null>;
}

/** DI token for the {@link ActiveKeyboardReadPort} read port. */
export const ACTIVE_KEYBOARD_STORE = Symbol('ACTIVE_KEYBOARD_STORE');

/**
 * L3 active reply-keyboard surface store (Story 16 / ADR 0045). Owns the
 * `assistant:keyboard:{userId}` Redis keyspace — a per-user flag whose value is
 * the id of the keyboard currently docked for that user. It is BOTH the write side
 * (set when a keyboard is docked, cleared when removed) and the read port the
 * inbound router gates on to disambiguate a keyboard tap from a user who literally
 * types a button label. Redis-only (no DB entity), matching the user-lock /
 * status-session precedent.
 *
 * Every method degrades never-throw: a Redis fault is swallowed (logged at debug)
 * and the read treated as "no active surface", because the inbound turn path is
 * `attempts:1` and an active-surface fault must never break a turn — at worst a
 * label is handled as ordinary conversation (the safe default, never a wrong
 * destructive action).
 *
 * See `docs/adr/0045-assistant-reply-keyboard-and-calendar.md`.
 */
@Injectable()
export class ActiveKeyboardStore implements ActiveKeyboardReadPort {
  private readonly logger = new Logger(ActiveKeyboardStore.name);

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly config: AssistantConfig,
  ) {}

  /**
   * Records which keyboard surface is now docked for the user (set on every
   * keyboard dock / swap). Stored with the last-button TTL family's short backstop
   * is intentionally NOT used here: the active-surface flag is durable for the
   * conversation, so it is set WITHOUT an expiry and only cleared explicitly on
   * Disconnect. Swallows a Redis fault — a failed set simply means the next typed
   * label is treated as conversation (the safe default).
   */
  async setActiveSurface(
    userId: string,
    surface: KeyboardSurface,
  ): Promise<void> {
    try {
      await this.redis.set(activeKeyboardKey(userId), surface);
    } catch (error) {
      this.logSwallowed('set', userId, error);
    }
  }

  /**
   * Returns the keyboard surface currently docked for the user, or null when none
   * is (key absent / unknown value). A Redis fault returns null (no active
   * surface) so a transient blip never mis-routes a typed label as a keyboard tap.
   */
  async getActiveSurface(userId: string): Promise<KeyboardSurface | null> {
    try {
      const value = await this.redis.get(activeKeyboardKey(userId));

      return toKeyboardSurface(value);
    } catch (error) {
      this.logSwallowed('get', userId, error);

      return null;
    }
  }

  /**
   * Clears the active-surface flag — called when the keyboard is removed
   * (Disconnect docks no keyboard). After this a typed label is ordinary
   * conversation again. Swallows a Redis fault; a stale flag is harmless because
   * an unlinked chat re-enters the linking handshake before any turn runs.
   */
  async clear(userId: string): Promise<void> {
    try {
      await this.redis.del(activeKeyboardKey(userId));
    } catch (error) {
      this.logSwallowed('clear', userId, error);
    }
  }

  /**
   * Logs a swallowed active-surface Redis fault at debug — the flag is best-effort,
   * so a fault is informational, never an error that should break or alarm a turn.
   */
  private logSwallowed(action: string, userId: string, error: unknown): void {
    const message = error instanceof Error ? error.message : 'unknown error';

    this.logger.debug(
      `active-keyboard ${action} degraded for user ${userId}: ${message}`,
    );
  }
}
