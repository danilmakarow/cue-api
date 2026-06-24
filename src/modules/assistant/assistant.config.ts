import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { EnvironmentVariables } from '@/config/env.config';

/**
 * Typed accessor for the assistant orchestration knobs, read via the injected
 * `ConfigService` (never `process.env`). The keys themselves are validated in
 * the global Zod env schema; this service exposes them with their defaults
 * already applied so the orchestrator and consumer stay free of config plumbing.
 */
@Injectable()
export class AssistantConfig {
  constructor(
    private readonly configService: ConfigService<EnvironmentVariables, true>,
  ) {}

  /**
   * Overall tool round-trip ceiling per user turn — a runaway backstop above the
   * schedule-fetch read cap.
   */
  get maxToolRoundtrips(): number {
    return this.configService.get('ASSISTANT_MAX_TOOL_ROUNDTRIPS', {
      infer: true,
    });
  }

  /**
   * Read cap on schedule fetches (`list_events` / `find_free_slots`) per turn
   * (ADR 0006 layer 3).
   */
  get maxScheduleFetches(): number {
    return this.configService.get('ASSISTANT_MAX_SCHEDULE_FETCHES', {
      infer: true,
    });
  }

  /**
   * Narration re-drive budget per turn (ADR 0009): the number of corrective
   * re-invocations allowed when the model claims a write but calls no tools.
   * `0` disables re-drive (kill-switch → detect-and-mask). Strictly below
   * {@link maxToolRoundtrips} so the round-trip ceiling is the outer bound.
   */
  get maxCorrections(): number {
    return this.configService.get('ASSISTANT_MAX_CORRECTIONS', {
      infer: true,
    });
  }

  /**
   * TTL (seconds) for the hot Redis mirror of a suspended `ask_user` question
   * (ADR 0010) — the free-text answer window. After it lapses a typed message is
   * a fresh turn; a button still resumes from Postgres within the retention
   * horizon.
   */
  get askUserTtlSeconds(): number {
    return this.configService.get('ASSISTANT_ASK_USER_TTL_SECONDS', {
      infer: true,
    });
  }

  /**
   * Hard durable retention (hours) for a suspended `ask_user` row (ADR 0010): a
   * button answer resumes from Postgres anytime within this horizon, even after
   * the Redis TTL and a process restart. The cleanup job expires rows past it.
   */
  get askUserRetentionHours(): number {
    return this.configService.get('ASSISTANT_ASK_USER_RETENTION_HOURS', {
      infer: true,
    });
  }

  /**
   * TTL (seconds) for the live-status handle (`StatusSession`, ADR 0012): the
   * per-chat/turn Redis pointer to the animated status surface. Short — it only
   * needs to outlive one in-flight turn and is cleared on finalize.
   */
  get statusSessionTtlSeconds(): number {
    return this.configService.get('ASSISTANT_STATUS_SESSION_TTL_SECONDS', {
      infer: true,
    });
  }

  /**
   * Tick interval (ms) for the status-surface ASCII spinner (R1 / ADR 0057): how
   * often the braille frame advances on the one live status message. Kept ~1000
   * (never sub-second) so the repeated `editMessageText` calls stay clear of
   * Telegram flood-control (429).
   */
  get statusSpinnerIntervalMs(): number {
    return this.configService.get('ASSISTANT_STATUS_SPINNER_INTERVAL_MS', {
      infer: true,
    });
  }

  /**
   * Auto-expiry TTL (ms) for the per-user serialization lock (Story 11): the
   * deadlock backstop a crashed holder relies on so the mutex self-releases. A
   * live holder extends it via the watchdog ({@link userLockRenewMs}).
   */
  get userLockTtlMs(): number {
    return this.configService.get('ASSISTANT_USER_LOCK_TTL_MS', {
      infer: true,
    });
  }

  /**
   * Watchdog renew interval (ms) for the per-user serialization lock (Story 11):
   * how often a live holder extends its TTL while work is in progress. MUST be
   * strictly below {@link userLockTtlMs} so the lock never lapses mid-turn.
   */
  get userLockRenewMs(): number {
    return this.configService.get('ASSISTANT_USER_LOCK_RENEW_MS', {
      infer: true,
    });
  }

  /**
   * Per-user inbound debounce window (ms, Story 14a / ADR 0042): how long a
   * freshly accepted simple message waits before its turn runs. Each new inbound
   * within the window re-arms it (the delayed drain job slides to now + this), so
   * rapid-fire bubbles collapse into ONE combined turn. ~2 s by default.
   */
  get debounceWindowMs(): number {
    return this.configService.get('ASSISTANT_DEBOUNCE_WINDOW_MS', {
      infer: true,
    });
  }

  /**
   * Queue-after re-arm delay (ms, Story 14a / ADR 0042): when a debounce drain
   * finds the per-user lock already held (a turn in flight), the drained batch is
   * re-buffered and the drain job re-scheduled this far out so it runs AFTER the
   * in-flight turn. Kept well below {@link userLockTtlMs} so a queued-after batch
   * re-polls promptly once the lock frees, and the lock's auto-expiry guarantees
   * no deadlock if the holder crashes.
   */
  get debounceQueueAfterMs(): number {
    return this.configService.get('ASSISTANT_DEBOUNCE_QUEUE_AFTER_MS', {
      infer: true,
    });
  }

  /**
   * TTL (seconds) for the latest reply-keyboard button result (Story 16 / ADR
   * 0045): how long the last deterministic button outcome line waits in Redis
   * before injection into the next model turn's volatile tail. Read-then-cleared
   * on the next turn, so this is only a self-cleaning backstop for a tap with no
   * follow-up message.
   */
  get lastButtonTtlSeconds(): number {
    return this.configService.get('ASSISTANT_LAST_BUTTON_TTL_SECONDS', {
      infer: true,
    });
  }

  /**
   * TTL (seconds) for the last-message-language tracker (R2 / ADR 0055): how long
   * the per-user last resolved loading-status locale stays in Redis to be borrowed
   * by the next turn's voice pre-STT "Listening…" line. Sticky (overwritten on each
   * known-language turn, never read-cleared), so this is only a self-cleaning
   * backstop for a user who goes quiet — kept long (~7 days).
   */
  get lastMessageLanguageTtlSeconds(): number {
    return this.configService.get(
      'ASSISTANT_LAST_MESSAGE_LANGUAGE_TTL_SECONDS',
      {
        infer: true,
      },
    );
  }

  /** TTL (seconds) for a single-use link nonce. */
  get linkNonceTtlSeconds(): number {
    return this.configService.get('ASSISTANT_LINK_NONCE_TTL_SECONDS', {
      infer: true,
    });
  }

  /** TTL (seconds) for the inbound-update dedupe guard. */
  get dedupeTtlSeconds(): number {
    return this.configService.get('ASSISTANT_DEDUPE_TTL_SECONDS', {
      infer: true,
    });
  }

  /** Number of recent messages kept verbatim in the prompt (ADR 0005 tier 1). */
  get recentWindowSize(): number {
    return this.configService.get('ASSISTANT_RECENT_WINDOW_SIZE', {
      infer: true,
    });
  }

  /** Preloaded agenda horizon in days (today + N), ADR 0006 layer 1. */
  get preloadHorizonDays(): number {
    return this.configService.get('ASSISTANT_PRELOAD_HORIZON_DAYS', {
      infer: true,
    });
  }

  /** Message-count threshold that triggers a background re-summary. */
  get summarizeThreshold(): number {
    return this.configService.get('ASSISTANT_SUMMARIZE_THRESHOLD', {
      infer: true,
    });
  }

  /**
   * Whether to translate transcribed voice notes to English. Mirrors the STT
   * connector's own default but surfaced here so the consumer can pass it.
   */
  get translateVoiceToEnglish(): boolean {
    return this.configService.get('STT_TRANSLATE_TO_ENGLISH', { infer: true });
  }

  /**
   * Public HTTPS base used to register the webhook on boot, or undefined when
   * unset (local dev via the ngrok script registers manually).
   */
  get webhookUrl(): string | undefined {
    return this.configService.get('ASSISTANT_WEBHOOK_URL', { infer: true });
  }

  /**
   * Public HTTPS base for the iOS universal link embedded in the linking prompt,
   * or undefined when unset (the prompt then offers the raw code only).
   */
  get appLinkBaseUrl(): string | undefined {
    return this.configService.get('ASSISTANT_APP_LINK_BASE_URL', {
      infer: true,
    });
  }
}
