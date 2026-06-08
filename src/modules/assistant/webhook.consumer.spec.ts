import { Job } from 'bullmq';

import { AssistantConfig } from './assistant.config';
import { AssistantService } from './assistant.service';
import { WebhookQueueJob } from './assistant.types';
import { LinkingService } from './linking.service';
import { WebhookConsumer } from './webhook.consumer';
import { User } from '@/modules/database/entities';
import { ExternalVendorConnectorFactory } from '@/modules/external-vendor/external-vendor-connector.factory';
import {
  InboundKind,
  NormalizedInboundMessage,
} from '@/modules/external-vendor/external-vendor.types';
import { SttConnector } from '@/modules/stt/stt-connector.abstract';
import { SttUnavailableError } from '@/modules/stt/stt.errors';
import { SttProvider } from '@/modules/stt/stt.types';

/**
 * Builds a `Job` wrapping a webhook queue payload for the given raw body.
 */
const buildJob = (body: string): Job<WebhookQueueJob> =>
  ({
    id: 'job-1',
    attemptsMade: 0,
    data: {
      vendor: 'telegram',
      ip: '1.2.3.4',
      headers: {},
      body,
      receivedAt: '2026-06-01T00:00:00.000Z',
      correlationId: 'cid-1',
    },
  }) as Job<WebhookQueueJob>;

/**
 * Assembles a `WebhookConsumer` with mocked collaborators and a programmable
 * connector returned by the vendor factory.
 */
const buildConsumer = (
  normalized: NormalizedInboundMessage | null,
  options: {
    link?: { userId: string } | null;
    dedupeAcquired?: boolean;
  } = {},
) => {
  const connector = {
    handleWebhook: jest.fn().mockResolvedValue(normalized),
    fetchMedia: jest.fn(),
    sendMessage: jest.fn().mockResolvedValue({ vendorMessageId: 'm-1' }),
  };
  const vendorFactory = {
    get: jest.fn().mockReturnValue(connector),
  } as unknown as ExternalVendorConnectorFactory;

  const redis = {
    set: jest
      .fn()
      .mockResolvedValue(options.dedupeAcquired === false ? null : 'OK'),
    del: jest.fn(),
  };

  const stt = {
    provider: SttProvider.OPENAI,
    transcribe: jest.fn(),
  } as unknown as jest.Mocked<SttConnector>;

  const telegramLinkDatabaseService = {
    findByTelegramChatId: jest
      .fn()
      .mockResolvedValue(
        options.link === undefined ? { userId: 'user-1' } : options.link,
      ),
  };
  const userDatabaseService = {
    findOneBy: jest
      .fn()
      .mockResolvedValue({ id: 'user-1', timezone: 'UTC' } as User),
  };
  const linkingService = {
    beginLinking: jest.fn().mockResolvedValue('Please connect in the app.'),
  };
  const assistantService = {
    handleText: jest.fn().mockResolvedValue(undefined),
    handleCommand: jest.fn().mockResolvedValue(undefined),
    handleCallback: jest.fn().mockResolvedValue(undefined),
  };
  const config = {
    dedupeTtlSeconds: 3600,
    translateVoiceToEnglish: false,
  } as unknown as AssistantConfig;

  const consumer = new WebhookConsumer(
    redis as never,
    stt,
    vendorFactory,
    telegramLinkDatabaseService as never,
    userDatabaseService as never,
    linkingService as unknown as LinkingService,
    assistantService as unknown as AssistantService,
    config,
  );

  return {
    consumer,
    connector,
    redis,
    stt,
    linkingService,
    assistantService,
    telegramLinkDatabaseService,
  };
};

describe('WebhookConsumer', () => {
  it('transcribes a voice note and routes the transcript to the orchestrator', async () => {
    const normalized: NormalizedInboundMessage = {
      kind: InboundKind.Voice,
      vendorChatId: 'chat-1',
      vendorUserId: 'u-1',
      dedupeId: '100',
      media: { vendorFileId: 'file-1', mimeHint: 'audio/ogg' },
    };
    const harness = buildConsumer(normalized);

    harness.connector.fetchMedia.mockResolvedValue({
      bytes: Buffer.from([1, 2, 3]),
      mimeType: 'audio/ogg',
    });
    harness.stt.transcribe.mockResolvedValue({ text: 'move my 3pm to 4' });

    await harness.consumer.process(buildJob('{"update_id":100}'));

    expect(harness.connector.fetchMedia).toHaveBeenCalledWith(normalized.media);
    expect(harness.stt.transcribe).toHaveBeenCalledTimes(1);
    expect(harness.assistantService.handleText).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user-1' }),
      expect.objectContaining({
        text: 'move my 3pm to 4',
        vendorChatId: 'chat-1',
      }),
    );
  });

  it('replies "couldn\'t hear that" and persists no turn when STT is unavailable', async () => {
    const normalized: NormalizedInboundMessage = {
      kind: InboundKind.Voice,
      vendorChatId: 'chat-1',
      vendorUserId: 'u-1',
      dedupeId: '101',
      media: { vendorFileId: 'file-1' },
    };
    const harness = buildConsumer(normalized);

    harness.connector.fetchMedia.mockResolvedValue({
      bytes: Buffer.from([1]),
      mimeType: 'audio/ogg',
    });
    harness.stt.transcribe.mockRejectedValue(
      new SttUnavailableError(SttProvider.OPENAI),
    );

    await harness.consumer.process(buildJob('{"update_id":101}'));

    expect(harness.connector.sendMessage).toHaveBeenCalledTimes(1);

    const [, message] = harness.connector.sendMessage.mock.calls[0];

    expect(message.text).toMatch(/didn't come through|hear/i);
    expect(harness.assistantService.handleText).not.toHaveBeenCalled();
  });

  it('drops a duplicate update without processing', async () => {
    const normalized: NormalizedInboundMessage = {
      kind: InboundKind.Text,
      vendorChatId: 'chat-1',
      vendorUserId: 'u-1',
      dedupeId: '102',
      text: 'hello',
    };
    const harness = buildConsumer(normalized, { dedupeAcquired: false });

    await harness.consumer.process(buildJob('{"update_id":102}'));

    expect(
      harness.telegramLinkDatabaseService.findByTelegramChatId,
    ).not.toHaveBeenCalled();
    expect(harness.assistantService.handleText).not.toHaveBeenCalled();
  });

  it('sends the linking prompt for an unlinked chat and never calls the orchestrator', async () => {
    const normalized: NormalizedInboundMessage = {
      kind: InboundKind.Text,
      vendorChatId: 'chat-9',
      vendorUserId: 'u-9',
      dedupeId: '103',
      text: 'hi bot',
    };
    const harness = buildConsumer(normalized, { link: null });

    await harness.consumer.process(buildJob('{"update_id":103}'));

    expect(harness.linkingService.beginLinking).toHaveBeenCalledWith(
      'chat-9',
      null,
    );
    expect(harness.connector.sendMessage).toHaveBeenCalledTimes(1);
    expect(harness.assistantService.handleText).not.toHaveBeenCalled();
  });

  it('routes a text message to the orchestrator for a linked user', async () => {
    const normalized: NormalizedInboundMessage = {
      kind: InboundKind.Text,
      vendorChatId: 'chat-1',
      vendorUserId: 'u-1',
      dedupeId: '104',
      text: 'what is on tomorrow?',
    };
    const harness = buildConsumer(normalized);

    await harness.consumer.process(buildJob('{"update_id":104}'));

    expect(harness.assistantService.handleText).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user-1' }),
      expect.objectContaining({
        text: 'what is on tomorrow?',
        correlationId: 'cid-1',
      }),
    );
  });

  it('routes a command to the orchestrator command handler', async () => {
    const normalized: NormalizedInboundMessage = {
      kind: InboundKind.Command,
      vendorChatId: 'chat-1',
      vendorUserId: 'u-1',
      dedupeId: '105',
      command: 'today',
      commandArgs: [],
    };
    const harness = buildConsumer(normalized);

    await harness.consumer.process(buildJob('{"update_id":105}'));

    expect(harness.assistantService.handleCommand).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user-1' }),
      expect.objectContaining({ command: 'today', correlationId: 'cid-1' }),
    );
  });

  it('releases the dedupe guard and rethrows when processing fails (so the job retries)', async () => {
    const normalized: NormalizedInboundMessage = {
      kind: InboundKind.Text,
      vendorChatId: 'chat-1',
      vendorUserId: 'u-1',
      dedupeId: '106',
      text: 'boom',
    };
    const harness = buildConsumer(normalized);

    harness.assistantService.handleText.mockRejectedValue(new Error('db down'));

    await expect(
      harness.consumer.process(buildJob('{"update_id":106}')),
    ).rejects.toThrow(/db down/);
    expect(harness.redis.del).toHaveBeenCalledTimes(1);
  });
});
