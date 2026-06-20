import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { Redis } from 'ioredis';

import { AssistantConfig } from './assistant.config';
import { AssistantService } from './assistant.service';
import { WebhookQueueJob } from './assistant.types';
import { classifyFlow } from './ingress/inbound-router';
import { LinkingService } from './linking.service';
import { PENDING_INTERACTION_STORE } from './session/pending-interaction.store';
import type { PendingInteractionStore } from './session/pending-interaction.store';
import { TurnRunnerService } from './session/turn-runner.service';
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
    private readonly turnRunner: TurnRunnerService,
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
   * Transcribes a voice note to text, mapping STT failures to a user-facing
   * reply. Returns the transcript, or null when STT failed (the caller replies
   * and persists no user turn, per the spec).
   */
  private async transcribeVoice(
    connector: ReturnType<ExternalVendorConnectorFactory['get']>,
    normalized: NormalizedInboundMessage,
  ): Promise<string | null> {
    if (!normalized.media) {
      return null;
    }

    try {
      const media = await connector.fetchMedia(normalized.media);
      const result = await this.stt.transcribe(media, {
        translateToEnglish: this.config.translateVoiceToEnglish,
      });

      return result.text;
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
   * (4-flow taxonomy) and dispatches the resulting flow: the two no-LLM paths
   * (command, conflict-confirm) keep their existing deterministic handlers; the
   * two model paths (simple message, answer) converge at the turn runner.
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

    if (normalized.kind === InboundKind.Voice) {
      const result = await this.transcribeVoice(connector, normalized);

      if (result === null) {
        return;
      }

      transcript = result;
    }

    const flow = await classifyFlow(
      normalized,
      user,
      this.pendingStore,
      transcript,
    );

    if (flow.kind === 'command') {
      await this.assistantService.handleCommand(user, {
        command: flow.command,
        args: flow.args,
        vendorChatId: normalized.vendorChatId,
        correlationId,
      });

      return;
    }

    if (flow.kind === 'conflict_confirm') {
      await this.assistantService.handleCallback(user, {
        callbackId: flow.callbackId,
        callbackData: flow.callbackData,
        vendorChatId: normalized.vendorChatId,
        correlationId,
      });

      return;
    }

    // Both remaining flows (simple_message, answer) converge at the turn runner.
    // A text message with no body is dropped (preserves the old `normalized.text`
    // guard); a voice transcript is always non-null here (STT-fail returned
    // above), and an answer carries the user's text/option.
    if (flow.contentType !== InboundKind.Voice && flow.text.length === 0) {
      return;
    }

    await this.turnRunner.runFromMessage({
      user,
      text: flow.text,
      kind: flow.contentType,
      vendorChatId: normalized.vendorChatId,
      correlationId,
      origin:
        flow.kind === 'answer' ? `answer_${flow.source}` : 'simple_message',
      // A button answer carries the callback id to acknowledge on resume; a
      // free-text answer / simple message has none.
      callbackId: flow.kind === 'answer' ? flow.callbackId : null,
    });
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
