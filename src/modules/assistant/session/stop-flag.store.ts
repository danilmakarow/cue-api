import { Inject, Injectable, Logger } from '@nestjs/common';
import { Redis } from 'ioredis';

import { stopFlagKey } from '../../redis/redis.constants';
import { REDIS_CLIENT } from '../../redis/redis.module';
import { AssistantConfig } from '../assistant.config';

/**
 * L3 cooperative STOP-flag store (Story 14b / ADR 0043). Owns the
 * `assistant:stop:{userId}:{turnId}` Redis keyspace — a per-user/per-turn flag the
 * user's STOP tap sets and the tool loop polls at its cooperative checkpoints
 * (between rounds + after each committed write). It is deliberately turn-scoped:
 * keying by BOTH the user id and the in-flight turn id (the correlationId) means a
 * stale flag from a previous turn can never abort a fresh turn, and a turn clears
 * its own key on exit. Redis-only (no DB entity), matching the held-conflict /
 * user-lock / status-session precedent.
 *
 * Every method degrades never-throw: a Redis fault is swallowed (logged at debug)
 * and treated as "no STOP requested" / "nothing to clear", because the inbound
 * turn path is `attempts:1` and a STOP-flag fault must never break a turn — at
 * worst the turn simply runs to completion as it would have without STOP.
 *
 * See `docs/adr/0043-assistant-stop-cooperative-cancellation.md`.
 */
@Injectable()
export class StopFlagStore {
  private readonly logger = new Logger(StopFlagStore.name);

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly config: AssistantConfig,
  ) {}

  /**
   * Arms the STOP flag for one user's in-flight turn (set on the STOP button tap),
   * with the configured TTL as a self-cleaning backstop. Swallows a Redis fault —
   * a failed arm simply means the turn runs to completion (the STOP is best-effort
   * cooperative cancellation, never a hard kill).
   */
  async arm(userId: string, turnId: string): Promise<void> {
    try {
      await this.redis.set(
        stopFlagKey(userId, turnId),
        '1',
        'EX',
        this.config.stopFlagTtlSeconds,
      );
    } catch (error) {
      this.logSwallowed('arm', userId, turnId, error);
    }
  }

  /**
   * Reports whether a STOP was requested for this exact user + turn. Polled by the
   * tool loop at each cooperative checkpoint. A Redis fault returns false (no STOP)
   * so a transient blip never aborts a turn that the user did not ask to stop.
   */
  async isStopRequested(userId: string, turnId: string): Promise<boolean> {
    try {
      const value = await this.redis.get(stopFlagKey(userId, turnId));

      return value !== null;
    } catch (error) {
      this.logSwallowed('check', userId, turnId, error);

      return false;
    }
  }

  /**
   * Clears this turn's STOP flag — called in the turn's `finally` so a STOP tapped
   * after the loop already finished never leaks into a later turn (the key is also
   * turn-scoped, so this is belt-and-braces). Swallows a Redis fault; the TTL is
   * the backstop if the explicit clear ever fails.
   */
  async clear(userId: string, turnId: string): Promise<void> {
    try {
      await this.redis.del(stopFlagKey(userId, turnId));
    } catch (error) {
      this.logSwallowed('clear', userId, turnId, error);
    }
  }

  /**
   * Logs a swallowed STOP-flag Redis fault at debug — the flag is best-effort, so
   * a fault is informational, never an error that should break or alarm the turn.
   */
  private logSwallowed(
    action: string,
    userId: string,
    turnId: string,
    error: unknown,
  ): void {
    const message = error instanceof Error ? error.message : 'unknown error';

    this.logger.debug(
      `stop-flag ${action} degraded for user ${userId} turn ${turnId}: ${message}`,
    );
  }
}
