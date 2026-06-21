import { Inject, Injectable, Logger } from '@nestjs/common';
import { Redis } from 'ioredis';

import { lastButtonKey } from '../../redis/redis.constants';
import { REDIS_CLIENT } from '../../redis/redis.module';
import { AssistantConfig } from '../assistant.config';

/**
 * Read port for the latest reply-keyboard button result (Story 16 / ADR 0045).
 * The context builder depends on this narrow interface (not the Redis client) so
 * the volatile-tail injection is unit-testable with a trivial stub, mirroring the
 * {@link PendingInteractionStore} / {@link ActiveKeyboardReadPort} pattern. The
 * builder asks ONLY "is there a pending button outcome for this user, and if so
 * claim it for the volatile tail" — overwrite-on-write, read-then-clear on read,
 * so the line is a one-shot nudge into exactly the next turn.
 */
export interface LastButtonReadPort {
  /**
   * Atomically reads AND clears the user's latest button outcome line (Redis
   * `GETDEL`), returning it for the volatile tail or null when none is pending.
   * Read-then-clear so the same outcome never bleeds into a second turn — it is
   * injected exactly once, into the immediately following turn's volatile tail.
   */
  takeLatest(userId: string): Promise<string | null>;
}

/** DI token for the {@link LastButtonReadPort} read port. */
export const LAST_BUTTON_STORE = Symbol('LAST_BUTTON_STORE');

/**
 * L3 latest-button-result store (Story 16 / ADR 0045). Owns the
 * `assistant:lastButton:{userId}` Redis keyspace — a per-user, overwrite-on-write
 * line describing the most recent deterministic keyboard-button outcome (e.g.
 * "Showed today's schedule"). The keyboard-action handler WRITES it after a tap;
 * the context builder READS-and-CLEARS it on the next model turn and injects it
 * into the VOLATILE TAIL only — never the cached prefix (ADR 0004 cache
 * stability). A short TTL is a self-cleaning backstop for a tap with no follow-up
 * message. Redis-only (no DB entity), matching the stop-flag / active-keyboard
 * precedent.
 *
 * Every method degrades never-throw: a Redis fault is swallowed (logged at debug);
 * a failed write simply omits the next turn's nudge and a failed read returns null
 * (no nudge). The inbound + turn paths are `attempts:1`, so a last-button fault
 * must never break a turn — at worst the model lacks one line of recent context.
 *
 * See `docs/adr/0045-assistant-reply-keyboard-and-calendar.md`.
 */
@Injectable()
export class LastButtonStore implements LastButtonReadPort {
  private readonly logger = new Logger(LastButtonStore.name);

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly config: AssistantConfig,
  ) {}

  /**
   * Records the latest button outcome line for the user (overwrites any prior
   * unconsumed line), with the configured TTL as a self-cleaning backstop so a tap
   * the user never follows up on self-expires. Swallows a Redis fault — a failed
   * write just omits one line of recent context from the next turn.
   */
  async record(userId: string, outcomeLine: string): Promise<void> {
    try {
      await this.redis.set(
        lastButtonKey(userId),
        outcomeLine,
        'EX',
        this.config.lastButtonTtlSeconds,
      );
    } catch (error) {
      this.logSwallowed('record', userId, error);
    }
  }

  /**
   * Atomically reads and clears the user's latest button outcome line (`GETDEL`),
   * returning it or null when none is pending. Read-then-clear so the line is a
   * one-shot nudge into exactly the next turn. A Redis fault returns null (no
   * nudge) so a transient blip never breaks the turn's context build.
   */
  async takeLatest(userId: string): Promise<string | null> {
    try {
      return await this.redis.getdel(lastButtonKey(userId));
    } catch (error) {
      this.logSwallowed('take', userId, error);

      return null;
    }
  }

  /**
   * Logs a swallowed last-button Redis fault at debug — the line is best-effort
   * context, so a fault is informational, never an error that should break a turn.
   */
  private logSwallowed(action: string, userId: string, error: unknown): void {
    const message = error instanceof Error ? error.message : 'unknown error';

    this.logger.debug(
      `last-button ${action} degraded for user ${userId}: ${message}`,
    );
  }
}
