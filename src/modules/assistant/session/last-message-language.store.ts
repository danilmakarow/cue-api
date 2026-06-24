import { Inject, Injectable, Logger } from '@nestjs/common';
import { Redis } from 'ioredis';

import { lastMessageLanguageKey } from '../../redis/redis.constants';
import { REDIS_CLIENT } from '../../redis/redis.module';
import { AssistantConfig } from '../assistant.config';
import { StatusLocale } from '../reply/status-phrases';

/**
 * The three locales the language tracker stores, restated as a runtime set so a
 * value read back from Redis can be validated (a corrupt / legacy value is
 * rejected rather than trusted) without importing a non-existent runtime symbol
 * from the type-only {@link StatusLocale}.
 */
const SUPPORTED_LOCALES: ReadonlySet<string> = new Set<StatusLocale>([
  'en',
  'uk',
  'ru',
]);

/**
 * Narrows an arbitrary Redis string to a {@link StatusLocale}, returning null
 * when it is none of `en` / `uk` / `ru` (absent, corrupt, or a legacy value). A
 * type guard so the caller gets the narrowed type for free.
 */
const isStatusLocale = (value: string | null): value is StatusLocale =>
  value !== null && SUPPORTED_LOCALES.has(value);

/**
 * L3 last-message-language store (R2 / ADR 0055). Owns the
 * `assistant:lastLang:{userId}` Redis keyspace — a per-user, overwrite-on-write
 * record of the last turn's resolved loading-status {@link StatusLocale}. The
 * turn runner WRITES it on every turn whose language is actually known (a typed
 * message, a free-text answer, or a voice turn AFTER STT); the voice PRE-STT
 * "Listening…" path READS it (peek) so a follow-up voice note borrows the prior
 * turn's language instead of falling back to a bare `en` while no transcript
 * exists yet.
 *
 * Unlike {@link LastButtonStore} (read-then-clear, a one-shot nudge) this tracker
 * is deliberately STICKY: {@link record} overwrites with last-write-wins (`SET EX`
 * WITHOUT `NX`) and {@link peek} is a plain `GET` (NOT `GETDEL`), so the value
 * survives across turns and is reused until the user's language changes. A long
 * TTL ({@link AssistantConfig.lastMessageLanguageTtlSeconds}) is a self-cleaning
 * backstop for a user who goes quiet. Redis-only (no DB entity), matching the
 * active-keyboard / last-button / user-lock precedent.
 *
 * Every method degrades never-throw: a Redis fault is swallowed (logged at
 * debug); a failed write simply leaves the prior value (or none) and a failed
 * read returns null (the cosmetic loading surface then falls back to `en`). The
 * inbound + turn paths are `attempts:1`, so a tracker fault must never break a
 * turn — at worst one voice notice shows the wrong loading language.
 *
 * See `docs/adr/0055-last-message-language-and-reply-language.md`.
 */
@Injectable()
export class LastMessageLanguageStore {
  private readonly logger = new Logger(LastMessageLanguageStore.name);

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly config: AssistantConfig,
  ) {}

  /**
   * Records the user's last resolved loading-status locale, overwriting any prior
   * value (last-write-wins — `SET EX` WITHOUT `NX`), with the configured TTL as a
   * self-cleaning backstop. Sticky on purpose: it is NOT cleared on read, so the
   * next turn can borrow it. Swallows a Redis fault — a failed write just leaves
   * the prior tracked language (or none) for the next voice notice.
   */
  async record(userId: string, locale: StatusLocale): Promise<void> {
    try {
      await this.redis.set(
        lastMessageLanguageKey(userId),
        locale,
        'EX',
        this.config.lastMessageLanguageTtlSeconds,
      );
    } catch (error) {
      this.logSwallowed('record', userId, error);
    }
  }

  /**
   * Reads (without clearing — plain `GET`) the user's last tracked loading-status
   * locale, or null when none is tracked or the stored value is not one of the
   * three supported locales. Sticky read: the value remains for subsequent turns.
   * A Redis fault returns null so a transient blip never breaks the turn — the
   * caller then falls back to `en`.
   */
  async peek(userId: string): Promise<StatusLocale | null> {
    try {
      const value = await this.redis.get(lastMessageLanguageKey(userId));

      return isStatusLocale(value) ? value : null;
    } catch (error) {
      this.logSwallowed('peek', userId, error);

      return null;
    }
  }

  /**
   * Logs a swallowed last-message-language Redis fault at debug — the tracked
   * locale is best-effort cosmetic context, so a fault is informational, never an
   * error that should break a turn.
   */
  private logSwallowed(action: string, userId: string, error: unknown): void {
    const message = error instanceof Error ? error.message : 'unknown error';

    this.logger.debug(
      `last-message-language ${action} degraded for user ${userId}: ${message}`,
    );
  }
}
