import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { Redis } from 'ioredis';

import { AssistantConfig } from './assistant.config';
import { AssistantService } from './assistant.service';
import { WebhookQueueJob } from './assistant.types';
import { LinkingService } from './linking.service';
import { dedupeKey, WEBHOOK_QUEUE_NAME } from '../redis/redis.constants';
import { REDIS_CLIENT } from '../redis/redis.module';
import {
  ConversationMessageContentType,
  User,
} from '@/modules/database/entities';
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
 * normalize voice via STT, then hand the turn to the orchestrator. A thrown job
 * releases its dedupe guard and propagates so BullMQ retries with backoff and
 * dead-letters after the configured attempts.
 */
@Processor(WEBHOOK_QUEUE_NAME)
export class WebhookConsumer extends WorkerHost {
  private readonly logger = new Logger(WebhookConsumer.name);

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(ACTIVE_STT_CONNECTOR) private readonly stt: SttConnector,
    private readonly vendorFactory: ExternalVendorConnectorFactory,
    private readonly telegramLinkDatabaseService: TelegramLinkDatabaseService,
    private readonly userDatabaseService: UserDatabaseService,
    private readonly linkingService: LinkingService,
    private readonly assistantService: AssistantService,
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
   * Routes a normalized message for a linked user to the right orchestrator
   * entry point (command / callback / voice / text).
   */
  private async routeForUser(
    user: User,
    connector: ReturnType<ExternalVendorConnectorFactory['get']>,
    normalized: NormalizedInboundMessage,
    correlationId: string,
  ): Promise<void> {
    if (normalized.kind === InboundKind.Command && normalized.command) {
      await this.assistantService.handleCommand(user, {
        command: normalized.command,
        args: normalized.commandArgs ?? [],
        vendorChatId: normalized.vendorChatId,
        correlationId,
      });

      return;
    }

    if (normalized.kind === InboundKind.Callback && normalized.callbackId) {
      await this.assistantService.handleCallback(user, {
        callbackId: normalized.callbackId,
        callbackData: normalized.callbackData ?? '',
        vendorChatId: normalized.vendorChatId,
        correlationId,
      });

      return;
    }

    if (normalized.kind === InboundKind.Voice) {
      const transcript = await this.transcribeVoice(connector, normalized);

      if (transcript === null) {
        return;
      }

      await this.assistantService.handleText(user, {
        text: transcript,
        contentType: ConversationMessageContentType.VOICE_TRANSCRIPT,
        vendorChatId: normalized.vendorChatId,
        vendorMessageId: null,
        correlationId,
      });

      return;
    }

    if (normalized.kind === InboundKind.Text && normalized.text) {
      await this.assistantService.handleText(user, {
        text: normalized.text,
        contentType: ConversationMessageContentType.TEXT,
        vendorChatId: normalized.vendorChatId,
        vendorMessageId: null,
        correlationId,
      });
    }
  }

  /**
   * Processes one accepted webhook job. Releases the dedupe guard and rethrows
   * on failure so BullMQ retries the durable job rather than dropping the update.
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
   * Logs a dead-lettered job after its retries are exhausted so a failed update
   * is never silently dropped.
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
