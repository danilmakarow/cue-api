import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { Redis } from 'ioredis';

import { AssistantConfig } from './assistant.config';
import { AssistantService } from './assistant.service';
import { WebhookQueueJob } from './assistant.types';
import { KeyboardActionService } from './commands/keyboard-action.service';
import { classifyFlow } from './ingress/inbound-router';
import { LinkingService } from './linking.service';
import {
  StatusAnimation,
  StatusAnimatorService,
} from './reply/status-animator.service';
import { ActiveKeyboardStore } from './session/active-keyboard.store';
import { DebounceCoordinatorService } from './session/debounce-coordinator.service';
import { LastMessageLanguageStore } from './session/last-message-language.store';
import { PENDING_INTERACTION_STORE } from './session/pending-interaction.store';
import type { PendingInteractionStore } from './session/pending-interaction.store';
import { dedupeKey, WEBHOOK_QUEUE_NAME } from '../redis/redis.constants';
import { REDIS_CLIENT } from '../redis/redis.module';
import { User } from '@/modules/database/entities';
import {
  TelegramLinkDatabaseService,
  UserDatabaseService,
} from '@/modules/database/services';
import { ExternalVendorConnectorFactory } from '@/modules/external-vendor/external-vendor-connector.factory';
import {
  InboundKind,
  NormalizedInboundMessage,
} from '@/modules/external-vendor/external-vendor.types';
import { SttConnector } from '@/modules/stt/stt-connector.abstract';
import { SttError, SttPayloadTooLargeError } from '@/modules/stt/stt.errors';
import { ACTIVE_STT_CONNECTOR } from '@/modules/stt/stt.module';

/** Reply when speech-to-text fails on a voice note (spec error table). */
const STT_UNAVAILABLE_REPLY =
  "I'm afraid that didn't come through clearly — care to try again, or type it?";

/** Reply when a voice note exceeds the provider's size limit. */
const STT_TOO_LARGE_REPLY =
  'That recording is a touch too long for me to hear — could you send a shorter one?';

/**
 * BullMQ consumer for accepted inbound webhook jobs. Runs the spec inbound
 * pipeline off the request path: parse+normalize via the vendor connector,
 * dedupe (Redis SET NX — queue delivery is at-least-once), resolve the user,
 * normalize voice via STT, then hand the turn to the orchestrator. This queue
 * is `attempts: 1` — a per-queue + per-job override of the global `attempts: 5`
 * default (ADR-0026) — because committed calendar writes are not idempotent and
 * a replayed turn would double-book (ADR-0009 / ADR-0016). So a thrown job does
 * NOT retry or dead-letter after N attempts: it fails immediately on its single
 * attempt. The catch only releases this update's Redis dedupe guard (note: with
 * attempts:1 + Telegram already 200'd at the controller, there is no automatic
 * re-processing of the same update — a genuine fresh resend could be processed),
 * and the failed job is retained for inspection (global `removeOnFail: false`),
 * where `onFailed` logs it.
 */
@Processor(WEBHOOK_QUEUE_NAME)
export class WebhookConsumer extends WorkerHost {
  private readonly logger = new Logger(WebhookConsumer.name);

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(ACTIVE_STT_CONNECTOR) private readonly stt: SttConnector,
    @Inject(PENDING_INTERACTION_STORE)
    private readonly pendingStore: PendingInteractionStore,
    private readonly vendorFactory: ExternalVendorConnectorFactory,
    private readonly telegramLinkDatabaseService: TelegramLinkDatabaseService,
    private readonly userDatabaseService: UserDatabaseService,
    private readonly linkingService: LinkingService,
    private readonly assistantService: AssistantService,
    private readonly keyboardActionService: KeyboardActionService,
    private readonly activeKeyboardStore: ActiveKeyboardStore,
    private readonly debounceCoordinator: DebounceCoordinatorService,
    private readonly statusAnimator: StatusAnimatorService,
    private readonly lastMessageLanguageStore: LastMessageLanguageStore,
    private readonly config: AssistantConfig,
  ) {
    super();
  }

  /**
   * Acquires the at-least-once dedupe guard for a normalized update. Returns
   * true when this worker won the guard (proceed), false when the update was
   * already handled (drop).
   */
  private async acquireDedupe(
    vendor: string,
    dedupeId: string,
  ): Promise<boolean> {
    const acquired = await this.redis.set(
      dedupeKey(vendor, dedupeId),
      '1',
      'EX',
      this.config.dedupeTtlSeconds,
      'NX',
    );

    return acquired === 'OK';
  }

  /**
   * Opens the live-status surface for a voice turn and shows a localized, plain
   * "listening…" line (one of several variants, ADR 0059) BEFORE STT runs. Keyed by
   * `correlationId` (the per-turn id) so it is the SAME idempotent StatusSession the
   * turn-runner re-opens after transcription — the voice notice then transitions
   * into the rotating-word loading draft. Degrades never-throw; the returned handle
   * is finalized by the caller only on the STT failure path (a successful turn hands
   * finalize to the turn-runner).
   *
   * The pre-STT line has no transcript or STT language yet, so its locale comes
   * from the `language_code` and — when that is unsupported/absent — the user's
   * last-message language borrowed from Redis (R2 / ADR 0055), so a follow-up
   * voice note keeps the conversation's language instead of snapping to `en`. The
   * peek is degrade-never-throw (a fault returns null → bare `language_code`/`en`).
   */
  private async beginVoiceStatus(
    userId: string,
    normalized: NormalizedInboundMessage,
    correlationId: string,
  ): Promise<StatusAnimation> {
    const priorLocale = await this.lastMessageLanguageStore.peek(userId);

    const animation = await this.statusAnimator.begin({
      vendorChatId: normalized.vendorChatId,
      turnId: correlationId,
      chatType: normalized.chatType,
      languageCode: normalized.languageCode,
      priorLocale: priorLocale ?? undefined,
    });

    await animation.showVoiceListening();

    return animation;
  }

  /**
   * Transcribes a voice note to text, mapping STT failures to a user-facing
   * reply. Returns the transcript AND the STT-reported spoken language (v2 Task 4
   * / ADR 0051 — previously the language was discarded), or null when STT failed
   * (the caller replies and persists no user turn, per the spec). The `language`
   * is best-effort: not every model reports it (e.g. OpenAI's `gpt-4o-*-transcribe`
   * return only text), so it is `undefined` then and the post-STT locale falls back
   * to detecting the transcript, then `language_code`, then `en`.
   */
  private async transcribeVoice(
    connector: ReturnType<ExternalVendorConnectorFactory['get']>,
    normalized: NormalizedInboundMessage,
  ): Promise<{ text: string; language?: string } | null> {
    if (!normalized.media) {
      return null;
    }

    try {
      const media = await connector.fetchMedia(normalized.media);
      const result = await this.stt.transcribe(media, {
        translateToEnglish: this.config.translateVoiceToEnglish,
      });

      return { text: result.text, language: result.language };
    } catch (error) {
      if (error instanceof SttError) {
        const reply =
          error instanceof SttPayloadTooLargeError
            ? STT_TOO_LARGE_REPLY
            : STT_UNAVAILABLE_REPLY;

        await connector.sendMessage(
          { vendorChatId: normalized.vendorChatId },
          { text: reply },
        );

        return null;
      }

      throw error;
    }
  }

  /**
   * Routes a normalized message for a linked user through the L2 inbound router
   * (flow taxonomy) and dispatches the resulting flow: the no-LLM paths (command,
   * keyboard-action) keep their deterministic handlers; the two model paths (simple
   * message, answer) converge at the turn runner.
   *
   * A voice note is transcribed BEFORE classification so it is routed by its
   * transcript exactly like a typed message (STT failure already replied and
   * persisted no turn → early return). A text message with no body is dropped.
   */
  private async routeForUser(
    user: User,
    connector: ReturnType<ExternalVendorConnectorFactory['get']>,
    normalized: NormalizedInboundMessage,
    correlationId: string,
  ): Promise<void> {
    let transcript: string | undefined;
    let sttLanguage: string | undefined;
    let voiceStatus: StatusAnimation | undefined;

    if (normalized.kind === InboundKind.Voice) {
      // Show a localized, plain "listening…" line (one of several variants, ADR
      // 0059) on the SAME (idempotent, keyed by correlationId) status surface the
      // turn-runner will re-use, so the voice notice transitions seamlessly into the
      // rotating-word loading draft once STT returns. The PRE-STT line uses
      // `language_code`/en (no text yet); the POST-STT loading words switch to the
      // spoken language once the turn re-opens this surface with `sttLanguage` + the
      // transcript (v2 Task 4 / ADR 0051). Begin/voice-state degrade never-throw.
      voiceStatus = await this.beginVoiceStatus(
        user.id,
        normalized,
        correlationId,
      );

      const result = await this.transcribeVoice(connector, normalized);

      if (result === null) {
        // STT failed (already replied). Finalize the voice surface so its Redis
        // StatusSession is cleared (no turn will run to clear it). No interval was
        // armed (voice-state shows a single frame), so there is nothing leaking.
        await voiceStatus.finalize();

        return;
      }

      transcript = result.text;
      // The STT-reported spoken language is the HIGHEST-priority locale signal for
      // the post-STT loading words (v2 Task 4 / ADR 0051); previously discarded.
      sttLanguage = result.language;
    }

    const flow = await classifyFlow(
      normalized,
      user,
      this.pendingStore,
      this.activeKeyboardStore,
      transcript,
    );

    if (flow.kind === 'command') {
      await this.assistantService.handleCommand(user, {
        command: flow.command,
        args: flow.args,
        vendorChatId: normalized.vendorChatId,
        correlationId,
      });

      // `/start` and `/link` are the (re)engagement entry points for an
      // already-linked user (Story 16 / ADR 0045): dock the persistent main reply
      // keyboard and mark it the active surface so [Today's schedule] [Next week]
      // [Settings] appear and a subsequent label tap routes deterministically.
      // Degrades never-throw (the keyboard send + Redis write both swallow faults).
      if (flow.command === 'start' || flow.command === 'link') {
        await this.keyboardActionService.showMainKeyboard(
          user,
          normalized.vendorChatId,
          'Tap a button below or just tell me what you need.',
          correlationId,
        );
      }

      return;
    }

    if (flow.kind === 'keyboard_action') {
      // A persistent reply-keyboard tap (Story 16 / ADR 0045): deterministic, NO
      // model. Render the requested ASCII calendar, swap the keyboard surface, or
      // disconnect — all direct reads/writes. It runs OUTSIDE the per-user lock /
      // debounce buffer (it never commits a calendar write and never coalesces with
      // a message), exactly like the command path, and records a latest-button line
      // the next model turn injects into its volatile tail.
      await this.keyboardActionService.handleKeyboardAction(user, {
        action: flow.action,
        vendorChatId: normalized.vendorChatId,
        correlationId,
      });

      return;
    }

    // Both remaining flows (simple_message, answer) reach the turn runner — but a
    // simple message goes through the debounce buffer first (Story 14a / ADR 0042)
    // while an answer to a pending `ask_user` question runs IMMEDIATELY (it must
    // never be combined with other messages or its resume would be corrupted).
    // A text message with no body is dropped (preserves the old `normalized.text`
    // guard); a voice transcript is always non-null here (STT-fail returned above).
    if (flow.contentType !== InboundKind.Voice && flow.text.length === 0) {
      return;
    }

    if (flow.kind === 'answer') {
      // The `ask_user` resume bypasses the debounce BUFFER (it must not coalesce
      // with a following message, and it acknowledges a specific callback) — but it
      // still runs under the SAME per-user lock as a simple-message turn (ADR 0042 /
      // Story 11), so a simple-message turn and an answer turn never run
      // concurrently for one user. If the lock is held the answer queues-after (a
      // fresh delayed job re-carries it) instead of racing the in-flight turn; the
      // resume's atomic claim still guards a double-resume.
      await this.debounceCoordinator.runAnswerExclusive(user, {
        text: flow.text,
        kind: flow.contentType,
        vendorChatId: normalized.vendorChatId,
        correlationId,
        origin: `answer_${flow.source}`,
        callbackId: flow.callbackId,
        chatType: normalized.chatType,
        languageCode: normalized.languageCode,
        // The STT-reported language (a voice answer) drives the post-STT loading
        // words; undefined for a typed answer (v2 Task 4 / ADR 0051).
        sttLanguage,
      });

      return;
    }

    // A fresh simple message is buffered into the user's ~2 s debounce window
    // (Story 14a / ADR 0042): rapid-fire bubbles combine into ONE turn, and the
    // delayed drain runs the turn under the per-user lock (queue-after mid-turn).
    // The buffer happens AFTER dedupe/linking/STT, so those stay intact + ordered.
    const isSeed = await this.debounceCoordinator.buffer(user.id, {
      text: flow.text,
      kind: flow.contentType,
      vendorChatId: normalized.vendorChatId,
      correlationId,
      // Live-status surface inputs (Story 12 / ADR 0012): the chat kind gates the
      // private-only draft. The loading-word locale follows the MESSAGE first (v2
      // Task 4 / ADR 0051): the combined text's detected language, the STT-reported
      // spoken language for a voice note (highest priority), then `language_code`.
      chatType: normalized.chatType,
      languageCode: normalized.languageCode,
      sttLanguage,
    });

    // FIX 3 — a NON-first voice note opened its own 'Listening…' surface (keyed by
    // its own correlationId), but the drained turn finalizes only the FIRST
    // buffered entry's surface (the seed). So finalize this voice surface now when
    // it did NOT become the seed, otherwise it lingers as a zombie draft until its
    // StatusSession TTL. The seed's surface is left for the turn to finalize.
    if (voiceStatus && !isSeed) {
      await voiceStatus.finalize();
    }
  }

  /**
   * Processes one accepted webhook job. On failure it releases this update's
   * dedupe guard and rethrows. Under `attempts: 1` (ADR-0026) the rethrow does
   * NOT replay the turn — a replay would re-run non-idempotent calendar writes
   * and double-book; the job fails immediately on its single attempt. The throw
   * only frees the dedupe key (so a genuine fresh resend of the same update can
   * be processed) and marks the job failed for inspection.
   */
  async process(job: Job<WebhookQueueJob>): Promise<void> {
    const data = job.data;
    const correlationId = data.correlationId;
    const connector = this.vendorFactory.get(data.vendor);

    const normalized = await connector.handleWebhook({
      rawBody: Buffer.from(data.body, 'utf8'),
      receivedAt: data.receivedAt,
    });

    if (!normalized) {
      return;
    }

    const acquired = await this.acquireDedupe(data.vendor, normalized.dedupeId);

    if (!acquired) {
      this.logger.debug(
        `[cid=${correlationId}] Dropping duplicate update ${data.vendor}:${normalized.dedupeId}`,
      );

      return;
    }

    try {
      const link = await this.telegramLinkDatabaseService.findByTelegramChatId(
        normalized.vendorChatId,
      );

      if (!link) {
        const prompt = await this.linkingService.beginLinking(
          normalized.vendorChatId,
          null,
        );

        await connector.sendMessage(
          { vendorChatId: normalized.vendorChatId },
          { text: prompt },
        );

        return;
      }

      const user = await this.userDatabaseService.findOneBy({
        id: link.userId,
      });

      if (!user) {
        this.logger.warn(
          `[cid=${correlationId}] TelegramLink ${link.id} points at missing user ${link.userId}`,
        );

        return;
      }

      await this.routeForUser(user, connector, normalized, correlationId);
    } catch (error) {
      await this.redis.del(dedupeKey(data.vendor, normalized.dedupeId));

      throw error;
    }
  }

  /**
   * Logs a failed job so a failed update is never silently dropped. Under
   * `attempts: 1` (ADR-0026) this fires on the job's single, terminal attempt —
   * there is no retry/backoff and no dead-letter after N attempts; the job is
   * retained (global `removeOnFail: false`) for inspection.
   */
  @OnWorkerEvent('failed')
  onFailed(job: Job<WebhookQueueJob> | undefined, error: Error): void {
    this.logger.error(
      `[cid=${job?.data?.correlationId ?? 'unknown'}] Webhook job ${
        job?.id ?? 'unknown'
      } failed (attempt ${job?.attemptsMade ?? 0}): ${error.message}`,
    );
  }
}
