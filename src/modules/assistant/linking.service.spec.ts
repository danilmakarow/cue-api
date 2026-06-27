import { HttpStatus } from '@nestjs/common';

import { LinkingService } from './linking.service';
import { TelegramLink } from '@/modules/database/entities';
import {
  InvalidLinkCodeException,
  TelegramLinkErrorCode,
} from '@/modules/telegram-link/exceptions/invalid-link-code.exception';

/** A linked `TelegramLink` row with a fixed `linkedAt` for deterministic assertions. */
const LINKED_AT = new Date('2026-06-01T12:30:00.000Z');

/**
 * Assembles a `LinkingService` with jest mocks for Redis, the telegram-link
 * database service, and the assistant config, exposing the mocks so each test
 * programs only what it needs. `appLinkBaseUrl` defaults to undefined (raw-code
 * prompt); tests set it to exercise the universal-link branch.
 */
const buildHarness = () => {
  const redis = { set: jest.fn().mockResolvedValue('OK'), getdel: jest.fn() };
  const telegramLinkDatabaseService = {
    findByUserId: jest.fn(),
    createInstance: jest.fn((partial) => partial as TelegramLink),
    save: jest.fn(async (entity) => entity as TelegramLink),
    delete: jest.fn().mockResolvedValue({ affected: 1, raw: [] }),
  };
  const config = {
    linkNonceTtlSeconds: 600,
    appLinkBaseUrl: undefined as string | undefined,
  };

  const service = new LinkingService(
    redis as never,
    telegramLinkDatabaseService as never,
    config as never,
  );

  return { service, redis, telegramLinkDatabaseService, config };
};

/** Builds a linked `TelegramLink` overlaid with the given fields. */
const buildLink = (over: Partial<TelegramLink> = {}): TelegramLink =>
  ({
    id: 'link-1',
    userId: 'user-1',
    telegramChatId: '12345',
    telegramUsername: 'tony',
    linkedAt: LINKED_AT,
    ...over,
  }) as TelegramLink;

describe('LinkingService', () => {
  describe('beginLinking', () => {
    it('returns a raw-code-only prompt when no app link base is configured', async () => {
      const harness = buildHarness();

      const message = await harness.service.beginLinking('12345', 'tony');

      expect(message).toContain('enter this code in the app:');
      expect(message).not.toContain('http');
      // The minted nonce is stashed in Redis with the configured TTL.
      expect(harness.redis.set).toHaveBeenCalledTimes(1);

      const [, payload, mode, ttl] = harness.redis.set.mock.calls[0];

      expect(JSON.parse(payload)).toEqual({
        vendorChatId: '12345',
        vendorUsername: 'tony',
      });
      expect(mode).toBe('EX');
      expect(ttl).toBe(600);
    });

    it('includes a tappable universal link and keeps the raw code when a base is configured', async () => {
      const harness = buildHarness();

      harness.config.appLinkBaseUrl = 'https://cue.ngrok.app/';

      const message = await harness.service.beginLinking('12345', 'tony');

      // The trailing slash on the base is trimmed; the nonce appears in both the
      // link and the paste fallback.
      const match = message.match(
        /https:\/\/cue\.ngrok\.app\/app\/telegram\/link\?code=([0-9a-f-]+)/,
      );

      expect(match).not.toBeNull();

      const nonceInLink = match![1];

      expect(message).toContain(`enter this code in the app: ${nonceInLink}`);
    });
  });

  describe('redeemNonce', () => {
    it('throws a typed InvalidLinkCodeException (422 + stable code body) when the nonce is unknown, expired, or already burned (M3)', async () => {
      const harness = buildHarness();

      harness.redis.getdel.mockResolvedValue(null);

      let caught: unknown;

      try {
        await harness.service.redeemNonce('user-1', 'missing');
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(InvalidLinkCodeException);

      // The typed body carries the stable machine-readable code the iOS client
      // branches on, under HTTP 422.
      const exception = caught as InvalidLinkCodeException;

      expect(exception.getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
      expect(exception.getResponse()).toMatchObject({
        code: TelegramLinkErrorCode.INVALID_LINK_CODE,
      });
    });

    it('burns the nonce and creates a link when none exists yet', async () => {
      const harness = buildHarness();

      harness.redis.getdel.mockResolvedValue(
        JSON.stringify({ vendorChatId: '12345', vendorUsername: 'tony' }),
      );
      harness.telegramLinkDatabaseService.findByUserId.mockResolvedValue(null);

      const result = await harness.service.redeemNonce('user-1', 'code-1');

      expect(
        harness.telegramLinkDatabaseService.createInstance,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          telegramChatId: '12345',
          telegramUsername: 'tony',
        }),
      );
      expect(harness.telegramLinkDatabaseService.save).toHaveBeenCalledTimes(1);
      expect(result.telegramChatId).toBe('12345');
    });
  });

  describe('getStatus', () => {
    it('reports not-linked with null fields when the user has no link', async () => {
      const harness = buildHarness();

      harness.telegramLinkDatabaseService.findByUserId.mockResolvedValue(null);

      const status = await harness.service.getStatus('user-1');

      expect(status).toEqual({
        linked: false,
        telegramUsername: null,
        linkedAt: null,
      });
      expect(
        harness.telegramLinkDatabaseService.findByUserId,
      ).toHaveBeenCalledWith('user-1');
    });

    it('reports linked with the username and an ISO linkedAt when a link exists', async () => {
      const harness = buildHarness();

      harness.telegramLinkDatabaseService.findByUserId.mockResolvedValue(
        buildLink(),
      );

      const status = await harness.service.getStatus('user-1');

      expect(status).toEqual({
        linked: true,
        telegramUsername: 'tony',
        linkedAt: LINKED_AT.toISOString(),
      });
    });
  });

  describe('unlink', () => {
    it('deletes the link and returns { linked: false } when one is present', async () => {
      const harness = buildHarness();

      harness.telegramLinkDatabaseService.findByUserId.mockResolvedValue(
        buildLink({ id: 'link-1' }),
      );

      const result = await harness.service.unlink('user-1');

      expect(harness.telegramLinkDatabaseService.delete).toHaveBeenCalledWith(
        'link-1',
      );
      expect(result).toEqual({ linked: false });
    });

    it('is idempotent and returns { linked: false } when no link exists', async () => {
      const harness = buildHarness();

      harness.telegramLinkDatabaseService.findByUserId.mockResolvedValue(null);

      const result = await harness.service.unlink('user-1');

      expect(harness.telegramLinkDatabaseService.delete).not.toHaveBeenCalled();
      expect(result).toEqual({ linked: false });
    });
  });
});
