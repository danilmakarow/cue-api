import { createHash } from 'node:crypto';

import { InjectQueue } from '@nestjs/bullmq';
import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Ip,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Queue } from 'bullmq';

import { WebhookQueueJob } from './assistant.types';
import { LinkTelegramDto } from './dtos';
import { LinkingService, TelegramLinkStatus } from './linking.service';
import { WEBHOOK_QUEUE_NAME } from '../redis/redis.constants';
import { CurrentUser } from '@/decorators/current-user.decorator';
import { AccessTokenGuard } from '@/guards/access-token.guard';
import { User } from '@/modules/database/entities';
import { ExternalVendorConnectorFactory } from '@/modules/external-vendor/external-vendor-connector.factory';

/** Inbound HTTP header values, as Node delivers them (single or repeated). */
type InboundHeaders = Record<string, string | string[] | undefined>;

/**
 * The assistant's HTTP surface:
 * - `POST /assistant/telegram/webhook` — vendor ingress. Authenticated by the
 *   connector's `acceptWebhook` (not the JWT guard); on accept it enqueues a
 *   durable job and returns 200 immediately; on reject it returns 401 and
 *   enqueues nothing. All real work happens in the consumer, off this path.
 * - `POST /assistant/link` — JWT-guarded; burns the link nonce and upserts the
 *   `TelegramLink`, returning the resulting link state.
 * - `GET /assistant/link` — JWT-guarded; reports the user's current link state.
 * - `DELETE /assistant/link` — JWT-guarded; revokes the user's link (idempotent).
 */
@Controller('assistant')
export class AssistantWebhookController {
  constructor(
    private readonly vendorFactory: ExternalVendorConnectorFactory,
    @InjectQueue(WEBHOOK_QUEUE_NAME)
    private readonly webhookQueue: Queue<WebhookQueueJob>,
    private readonly linkingService: LinkingService,
  ) {}

  /**
   * Normalizes inbound headers (which may carry repeated values) into the
   * single-value shape the vendor connector expects.
   */
  private static normalizeHeaders(
    raw: InboundHeaders,
  ): Record<string, string | undefined> {
    const headers: Record<string, string | undefined> = {};

    for (const [key, value] of Object.entries(raw)) {
      headers[key] = Array.isArray(value) ? value[0] : value;
    }

    return headers;
  }

  /**
   * Telegram (and any vendor) ingress. Authenticates via the connector, enqueues
   * the raw update for off-request processing, and returns 200 fast. The BullMQ
   * job id is a content hash so an identical re-delivery collapses at the queue;
   * the consumer additionally dedupes on the normalized update id.
   */
  @Post('telegram/webhook')
  @HttpCode(200)
  async handleTelegramWebhook(
    @Headers() rawHeaders: InboundHeaders,
    @Ip() ip: string,
    @Body() body: unknown,
  ): Promise<{ ok: true }> {
    const connector = this.vendorFactory.getActive();
    const headers = AssistantWebhookController.normalizeHeaders(rawHeaders);
    const bodyString = JSON.stringify(body ?? {});

    const accepted = await connector.acceptWebhook({
      headers,
      rawBody: Buffer.from(bodyString, 'utf8'),
    });

    if (!accepted) {
      throw new UnauthorizedException('Invalid webhook signature');
    }

    const job: WebhookQueueJob = {
      vendor: connector.vendor,
      ip: ip ?? '',
      headers,
      body: bodyString,
      receivedAt: new Date().toISOString(),
    };
    const jobId = createHash('sha256').update(bodyString).digest('hex');

    await this.webhookQueue.add('inbound', job, { jobId });

    return { ok: true };
  }

  /**
   * App-initiated linking: redeems the single-use nonce over an authenticated
   * session, binds this user to the Telegram chat, and returns the link state.
   */
  @Post('link')
  @UseGuards(AccessTokenGuard)
  async link(
    @CurrentUser() user: User,
    @Body() dto: LinkTelegramDto,
  ): Promise<TelegramLinkStatus> {
    const link = await this.linkingService.redeemNonce(user.id, dto.code);

    return {
      linked: true,
      telegramUsername: link.telegramUsername,
      linkedAt: link.linkedAt.toISOString(),
    };
  }

  /**
   * Reports the signed-in user's current Telegram link state for the iOS
   * Settings screen.
   */
  @Get('link')
  @UseGuards(AccessTokenGuard)
  async getLinkStatus(@CurrentUser() user: User): Promise<TelegramLinkStatus> {
    return this.linkingService.getStatus(user.id);
  }

  /**
   * Revokes the signed-in user's Telegram link. Idempotent — succeeds whether or
   * not a link was present.
   */
  @Delete('link')
  @UseGuards(AccessTokenGuard)
  async unlink(@CurrentUser() user: User): Promise<{ linked: false }> {
    return this.linkingService.unlink(user.id);
  }
}
