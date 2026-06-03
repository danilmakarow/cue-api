import { randomUUID } from 'node:crypto';

import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Redis } from 'ioredis';

import { AssistantConfig } from './assistant.config';
import { LINKING_PROMPT_INTRO } from './assistant.prompts';
import { linkNonceKey } from '../redis/redis.constants';
import { REDIS_CLIENT } from '../redis/redis.module';
import { TelegramLink } from '@/modules/database/entities';
import { TelegramLinkDatabaseService } from '@/modules/database/services';

/**
 * The chat details stashed under a link nonce while the user completes the
 * handshake in the iOS app.
 */
interface LinkNoncePayload {
  vendorChatId: string;
  vendorUsername: string | null;
}

/**
 * Public link state returned to the iOS app by `GET`/`POST`/`DELETE
 * /assistant/link`. `linkedAt` is an ISO-8601 string for display-only use on the
 * client (no coupling to the shared decoder's date strategy).
 */
export interface TelegramLinkStatus {
  linked: boolean;
  telegramUsername: string | null;
  linkedAt: string | null;
}

/**
 * Owns the Telegram linking handshake (spec "Linking / auth flow"):
 * - for an inbound message from an unlinked chat, mints a single-use nonce in
 *   Redis (short TTL) and returns the prompt that asks the user to confirm in
 *   the app — the LLM is never called for an unlinked chat;
 * - for `POST /assistant/link`, burns the nonce and upserts the `TelegramLink`.
 */
@Injectable()
export class LinkingService {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly telegramLinkDatabaseService: TelegramLinkDatabaseService,
    private readonly config: AssistantConfig,
  ) {}

  /**
   * Mints a single-use link nonce for an unlinked chat and returns the prompt to
   * send back. The nonce maps to the chat for the TTL window; the iOS app
   * redeems it over an authenticated session via `redeemNonce`.
   */
  async beginLinking(
    vendorChatId: string,
    vendorUsername: string | null,
  ): Promise<string> {
    const nonce = randomUUID();
    const payload: LinkNoncePayload = { vendorChatId, vendorUsername };

    await this.redis.set(
      linkNonceKey(nonce),
      JSON.stringify(payload),
      'EX',
      this.config.linkNonceTtlSeconds,
    );

    const appLinkBaseUrl = this.config.appLinkBaseUrl;

    if (!appLinkBaseUrl) {
      return `${LINKING_PROMPT_INTRO}\n\nOpen Cue and tap "Connect Telegram", or enter this code in the app: ${nonce}`;
    }

    const universalLink = `${appLinkBaseUrl.replace(/\/$/, '')}/app/telegram/link?code=${nonce}`;

    return `${LINKING_PROMPT_INTRO}\n\nOpen Cue to connect: ${universalLink}\n\nOr enter this code in the app: ${nonce}`;
  }

  /**
   * Burns the nonce (single-use, atomic via GETDEL) and upserts the
   * `TelegramLink` binding the chat to the signed-in user. Throws
   * `NotFoundException` when the code is unknown or expired.
   */
  async redeemNonce(userId: string, code: string): Promise<TelegramLink> {
    const raw = await this.redis.getdel(linkNonceKey(code));

    if (!raw) {
      throw new NotFoundException('Invalid or expired linking code');
    }

    const payload = JSON.parse(raw) as LinkNoncePayload;

    return this.upsertLink(userId, payload);
  }

  /**
   * Returns the user's current Telegram link state for the iOS Settings screen.
   * Reports `linked: false` with null fields when the user has no link.
   */
  async getStatus(userId: string): Promise<TelegramLinkStatus> {
    const link = await this.telegramLinkDatabaseService.findByUserId(userId);

    if (!link) {
      return { linked: false, telegramUsername: null, linkedAt: null };
    }

    return {
      linked: true,
      telegramUsername: link.telegramUsername,
      linkedAt: link.linkedAt.toISOString(),
    };
  }

  /**
   * Revokes the user's Telegram link if one exists. Idempotent — returns
   * `{ linked: false }` whether or not a link was present.
   */
  async unlink(userId: string): Promise<{ linked: false }> {
    const link = await this.telegramLinkDatabaseService.findByUserId(userId);

    if (!link) {
      return { linked: false };
    }

    await this.telegramLinkDatabaseService.delete(link.id);

    return { linked: false };
  }

  /**
   * Creates or updates the user's `TelegramLink` to point at the redeemed chat,
   * short-circuiting when nothing changed (per the save-only convention).
   */
  private async upsertLink(
    userId: string,
    payload: LinkNoncePayload,
  ): Promise<TelegramLink> {
    const existing =
      await this.telegramLinkDatabaseService.findByUserId(userId);

    if (!existing) {
      const created = this.telegramLinkDatabaseService.createInstance({
        userId,
        telegramChatId: payload.vendorChatId,
        telegramUsername: payload.vendorUsername,
        linkedAt: new Date(),
      });

      return this.telegramLinkDatabaseService.save(created);
    }

    const hasChanges =
      existing.telegramChatId !== payload.vendorChatId ||
      existing.telegramUsername !== payload.vendorUsername;

    if (!hasChanges) {
      return existing;
    }

    existing.telegramChatId = payload.vendorChatId;
    existing.telegramUsername = payload.vendorUsername;
    existing.linkedAt = new Date();

    return this.telegramLinkDatabaseService.save(existing);
  }
}
