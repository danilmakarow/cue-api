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

  /** TTL (seconds) for a held conflicting write awaiting user confirmation. */
  get heldConflictTtlSeconds(): number {
    return this.configService.get('ASSISTANT_HELD_CONFLICT_TTL_SECONDS', {
      infer: true,
    });
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
