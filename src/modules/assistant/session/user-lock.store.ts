import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { Redis } from 'ioredis';

import { userLockKey } from '../../redis/redis.constants';
import { REDIS_CLIENT } from '../../redis/redis.module';
import { AssistantConfig } from '../assistant.config';

/**
 * Lua: release the lock ONLY if the caller still holds the exact token. A plain
 * `DEL` would let a caller delete a lock that has since expired and been
 * re-acquired by someone else; the compare-and-del closes that race so only the
 * true holder ever unlocks. Returns 1 on a token-matched delete, 0 otherwise.
 */
const RELEASE_IF_HOLDER = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
else
  return 0
end`;

/**
 * Lua: extend the TTL ONLY if the caller still holds the exact token. Guards the
 * watchdog from renewing a lock that already expired and was re-acquired by
 * another holder (which would silently steal time from the new owner). Returns 1
 * on a token-matched `PEXPIRE`, 0 otherwise.
 */
const RENEW_IF_HOLDER = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('pexpire', KEYS[1], ARGV[2])
else
  return 0
end`;

/**
 * An acquired per-user lock: the unique fencing token plus the bound watchdog
 * timer. The token is required for {@link UserLockStore.release} and
 * {@link UserLockStore.renew}; the handle is what {@link UserLockStore.runExclusive}
 * tears down in its `finally`.
 */
export interface UserLockHandle {
  userId: string;
  token: string;
  /** The watchdog interval renewing the TTL, or undefined when watchdog is off. */
  watchdog?: NodeJS.Timeout;
}

/**
 * Per-user serialization lock (L3, Story 11 / ADR 0039) — a shared Redis mutex
 * keyed `assistant:lock:{userId}`. It serializes a single user's turns so two
 * inbound updates (or a mid-turn message, or a racing `ask_user` resume) never
 * run the loop concurrently for the same user; different users never contend.
 *
 * Mechanics:
 * - **Acquire** = `SET key token NX PX <ttlMs>`. NX makes it mutually exclusive;
 *   the unique `randomUUID` token identifies the holder; PX auto-expires it so a
 *   crashed holder NEVER deadlocks (the TTL is the deadlock backstop).
 * - **Release** = token-checked Lua compare-and-del — only the holder unlocks.
 * - **Renew** = a watchdog that token-checks then `PEXPIRE`s, extending the TTL
 *   while work is in progress so a long turn outlives the auto-expiry.
 * - **runExclusive** wraps a unit of work, ALWAYS releasing + clearing the
 *   watchdog in a `finally`, and returns a sentinel when the lock is already held.
 *
 * Intended integration points (the primitive is built here; call sites are NOT
 * retro-fitted by this story — see ADR 0039):
 * - **Story 14 queue-after**: wrap `TurnRunner.runTurn` in `runExclusive` so a
 *   mid-turn message queues AFTER the in-flight turn instead of racing it.
 * - **ADR-0010 `ask_user` resume double-resume race**: hold this lock across the
 *   `claimHotByUser`/`claimById` + re-invoke so two concurrent answers to one
 *   open question cannot both resume the same suspended turn.
 *
 * Redis-only (no DB entity), matching the held-conflict / status-session
 * precedent. See `docs/adr/0039-assistant-per-user-serialization-lock.md`.
 */
@Injectable()
export class UserLockStore {
  private readonly logger = new Logger(UserLockStore.name);

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly config: AssistantConfig,
  ) {}

  /**
   * Attempts to acquire the user's lock WITHOUT a watchdog. Returns the unique
   * token on success (the caller MUST pass it to {@link release}), or null when
   * the lock is already held by someone else. Uses `SET NX PX` so acquisition is
   * atomic and the lock self-expires after the configured TTL.
   */
  async acquire(userId: string): Promise<string | null> {
    const token = randomUUID();
    const result = await this.redis.set(
      userLockKey(userId),
      token,
      'PX',
      this.config.userLockTtlMs,
      'NX',
    );

    return result === 'OK' ? token : null;
  }

  /**
   * Releases the user's lock, but ONLY when `token` still matches the stored
   * value (token-checked Lua compare-and-del). Returns true when this caller's
   * token actually unlocked the key, false when the lock had already expired or
   * been taken over by another holder. Safe to call unconditionally in a
   * `finally` — a non-holder release is a harmless no-op.
   */
  async release(userId: string, token: string): Promise<boolean> {
    const deleted = (await this.redis.eval(
      RELEASE_IF_HOLDER,
      1,
      userLockKey(userId),
      token,
    )) as number;

    return deleted === 1;
  }

  /**
   * Extends the lock's TTL by the configured TTL, ONLY when `token` still holds
   * the key (token-checked). Returns true on a successful renew, false when the
   * caller no longer holds the lock (it expired and/or was re-acquired). The
   * watchdog uses this so it can stop renewing once ownership is lost rather than
   * stomping a new holder's lease.
   */
  async renew(userId: string, token: string): Promise<boolean> {
    const renewed = (await this.redis.eval(
      RENEW_IF_HOLDER,
      1,
      userLockKey(userId),
      token,
      this.config.userLockTtlMs.toString(),
    )) as number;

    return renewed === 1;
  }

  /**
   * Starts a watchdog that periodically {@link renew}s the lock while work runs,
   * keeping a long turn alive past the auto-expiry TTL. The interval is
   * `userLockRenewMs` (strictly below the TTL). The timer is `unref`'d so it never
   * keeps the process alive on its own; the caller MUST clear it (via the returned
   * handle / {@link runExclusive}'s `finally`). A renew that returns false (lock
   * lost) self-clears the watchdog so it stops stomping a new holder.
   */
  private startWatchdog(userId: string, token: string): NodeJS.Timeout {
    const watchdog = setInterval(() => {
      void this.renew(userId, token)
        .then((stillHeld) => {
          if (!stillHeld) {
            clearInterval(watchdog);
          }
        })
        .catch((error: unknown) => {
          this.logger.warn(
            `user-lock watchdog renew failed for ${userId}: ${String(error)}`,
          );
        });
    }, this.config.userLockRenewMs);

    watchdog.unref?.();

    return watchdog;
  }

  /**
   * Acquires the lock WITH a watchdog and returns the live handle, or null when
   * the lock is already held. Lower-level than {@link runExclusive} for callers
   * that own their own try/finally; most callers should prefer `runExclusive`.
   */
  async acquireWithWatchdog(userId: string): Promise<UserLockHandle | null> {
    const token = await this.acquire(userId);

    if (!token) {
      return null;
    }

    return { userId, token, watchdog: this.startWatchdog(userId, token) };
  }

  /**
   * Tears down an acquired handle: clears its watchdog (timer-leak guard) and
   * token-releases the lock. Idempotent and safe in a `finally`.
   */
  async releaseHandle(handle: UserLockHandle): Promise<void> {
    if (handle.watchdog) {
      clearInterval(handle.watchdog);
    }

    await this.release(handle.userId, handle.token);
  }

  /**
   * Runs `work` while holding the user's lock, ALWAYS releasing it and clearing
   * the watchdog in a `finally` (so neither a thrown error nor an early return
   * leaks the lock or the timer). When the lock is already held by another turn,
   * `work` is NOT run and the configured `onBusy` value is returned instead — the
   * caller decides whether "busy" means queue-after, drop, or reply. The lock
   * auto-expires regardless, so a crash inside `work` cannot deadlock the user.
   */
  async runExclusive<TResult>(
    userId: string,
    work: () => Promise<TResult>,
    onBusy: () => TResult,
  ): Promise<TResult> {
    const handle = await this.acquireWithWatchdog(userId);

    if (!handle) {
      return onBusy();
    }

    try {
      return await work();
    } finally {
      await this.releaseHandle(handle);
    }
  }
}
