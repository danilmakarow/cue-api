import { Inject, Injectable, Logger } from '@nestjs/common';
import { Redis } from 'ioredis';

import { menuMessageKey } from '../../redis/redis.constants';
import { REDIS_CLIENT } from '../../redis/redis.module';

/**
 * L3 last-menu-message store (R4 / ADR 0056). Owns the `assistant:menu:{userId}`
 * Redis keyspace — a per-user, overwrite-on-write record of the vendor message id
 * of the LAST docked Menu card. The keyboard-action handler WRITES it after
 * sending a fresh menu card and TAKES (read-and-clear) the prior id so it can
 * dedup-delete the stale card — send-new-first, delete-old-after, so the worst
 * case is one extra bubble, never zero (there is no per-user lock on this path).
 *
 * Durable on purpose: the value is stored WITHOUT a TTL (a plain `SET`, like
 * {@link ActiveKeyboardStore}), because a menu card lives indefinitely in the
 * chat until the user opens a new one — there is no natural expiry window after
 * which a stale-but-present card should stop being dedup-deleted. A TTL would
 * silently orphan a still-visible card. The id is cleared explicitly on Logout
 * (so a re-link starts clean) and replaced atomically on each re-open. Redis-only
 * (no DB entity), matching the active-keyboard / last-button / user-lock precedent.
 *
 * Every method degrades never-throw: a Redis fault is swallowed (logged at debug);
 * a failed write simply leaves the prior id (or none) and a failed read returns
 * null (no dedup-delete this round — one extra card, never a broken turn). The
 * inbound path is `attempts:1`, so a menu-store fault must never break a turn.
 *
 * See `docs/adr/0056-assistant-reply-keyboard-menu.md`.
 */
@Injectable()
export class LastMenuStore {
  private readonly logger = new Logger(LastMenuStore.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /**
   * Records the vendor message id of the user's freshly-docked Menu card,
   * overwriting any prior id (last-write-wins — plain `SET`, no TTL so the id is
   * durable for as long as the card lives in the chat). Swallows a Redis fault —
   * a failed write just means the next open cannot dedup-delete this card.
   */
  async record(userId: string, vendorMessageId: string): Promise<void> {
    try {
      await this.redis.set(menuMessageKey(userId), vendorMessageId);
    } catch (error) {
      this.logSwallowed('record', userId, error);
    }
  }

  /**
   * Atomically reads AND clears the user's prior Menu-card message id (`GETDEL`),
   * returning it for the dedup-delete or null when none is tracked. Read-then-clear
   * so each stored id is consumed exactly once — the handler deletes the prior card
   * then records the new id. A Redis fault returns null (skip the dedup-delete this
   * round) so a transient blip never breaks the turn.
   */
  async take(userId: string): Promise<string | null> {
    try {
      return await this.redis.getdel(menuMessageKey(userId));
    } catch (error) {
      this.logSwallowed('take', userId, error);

      return null;
    }
  }

  /**
   * Clears the tracked Menu-card id without reading it — called on Logout so a
   * later re-link starts with no stale card to dedup-delete. Swallows a Redis
   * fault; a stale id is harmless because the unlinked chat re-enters the linking
   * handshake before any menu is shown again.
   */
  async clear(userId: string): Promise<void> {
    try {
      await this.redis.del(menuMessageKey(userId));
    } catch (error) {
      this.logSwallowed('clear', userId, error);
    }
  }

  /**
   * Logs a swallowed last-menu Redis fault at debug — the tracked id is best-effort
   * dedup context, so a fault is informational, never an error that should break a
   * turn.
   */
  private logSwallowed(action: string, userId: string, error: unknown): void {
    const message = error instanceof Error ? error.message : 'unknown error';

    this.logger.debug(
      `last-menu ${action} degraded for user ${userId}: ${message}`,
    );
  }
}
