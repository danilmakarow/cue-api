import { Job } from 'bullmq';

import { AssistantConfig } from './assistant.config';
import { AssistantService } from './assistant.service';
import { WebhookQueueJob } from './assistant.types';
import { LinkingService } from './linking.service';
import { KeyboardSurface } from './reply/reply-keyboard.layout';
import { DebounceCoordinatorService } from './session/debounce-coordinator.service';
import { PendingInteractionStore } from './session/pending-interaction.store';
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
    hasPendingQuestion?: boolean;
    activeKeyboardSurface?: KeyboardSurface | null;
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
    handleCommand: jest.fn().mockResolvedValue(undefined),
    handleCallback: jest.fn().mockResolvedValue(undefined),
  };
  // Story 16 (ADR 0045): the deterministic reply-keyboard action handler the
  // consumer dispatches a `keyboard_action` flow to (renders a calendar / swaps the
  // keyboard / disconnects — never buffers, never runs the loop).
  const keyboardActionService = {
    handleKeyboardAction: jest.fn().mockResolvedValue(undefined),
    showMainKeyboard: jest.fn().mockResolvedValue(undefined),
  };
  // Story 16 (ADR 0045): the active reply-keyboard surface read port the inbound
  // router gates a typed label on. Defaults to null (NO keyboard docked) so an
  // ordinary typed message routes exactly as before — a label is a keyboard action
  // only when this resolves to the surface owning it.
  const activeKeyboardStore = {
    getActiveSurface: jest
      .fn()
      .mockResolvedValue(options.activeKeyboardSurface ?? null),
  };
  // The pending-interaction store gates the free-text answer flow. For this wave
  // it resolves false by default (no question is ever created), so a typed
  // message routes as a fresh simple message exactly as before.
  const pendingStore: jest.Mocked<PendingInteractionStore> = {
    hasPendingQuestion: jest
      .fn()
      .mockResolvedValue(options.hasPendingQuestion ?? false),
  };
  // Story 14a (ADR 0042): both model-driven flows now go through the debounce
  // coordinator — a fresh simple message is BUFFERED into the per-user window
  // (`buffer`), while an `ask_user` answer (never coalesced) runs under the SAME
  // per-user lock via `runAnswerExclusive` (FIX 2: serialized with simple-message
  // turns, queue-after on a held lock). `buffer` resolves to whether the entry was
  // the window's FIRST (the seed) — the consumer finalizes a non-seed voice surface
  // itself (FIX 3). We mock the coordinator so the routing assertions target the
  // seam the consumer dispatches to.
  const debounceCoordinator = {
    buffer: jest.fn().mockResolvedValue(true),
    runAnswerExclusive: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<DebounceCoordinatorService>;
  const config = {
    dedupeTtlSeconds: 3600,
    translateVoiceToEnglish: false,
    debounceWindowMs: 2000,
    debounceQueueAfterMs: 750,
  } as unknown as AssistantConfig;

  // Story 12 (L9 live status): a voice turn shows the localized "Listening…" line
  // on an idempotent status surface BEFORE STT, then hands off to the turn-runner.
  // We stub the animator with an inert handle so the routing assertions are
  // unaffected; the surface behaviour is covered in status-animator.service.spec.ts.
  const statusAnimation = {
    open: jest.fn().mockResolvedValue(undefined),
    showVoiceListening: jest.fn().mockResolvedValue(undefined),
    startLoading: jest.fn().mockResolvedValue(undefined),
    finalize: jest.fn().mockResolvedValue(undefined),
  };
  const statusAnimator = {
    begin: jest.fn().mockResolvedValue(statusAnimation),
  };
  // R2 (ADR 0055): the consumer peeks the last-message language for the pre-STT
  // "Listening…" line. Degrade-never-throw, so a null peek is the inert default.
  const lastMessageLanguageStore = {
    peek: jest.fn().mockResolvedValue(null),
    record: jest.fn(),
  };

  const consumer = new WebhookConsumer(
    redis as never,
    stt,
    pendingStore,
    vendorFactory,
    telegramLinkDatabaseService as never,
    userDatabaseService as never,
    linkingService as unknown as LinkingService,
    assistantService as unknown as AssistantService,
    keyboardActionService as never,
    activeKeyboardStore as never,
    debounceCoordinator,
    statusAnimator as never,
    lastMessageLanguageStore as never,
    config,
  );

  return {
    consumer,
    connector,
    redis,
    stt,
    linkingService,
    assistantService,
    keyboardActionService,
    activeKeyboardStore,
    pendingStore,
    debounceCoordinator,
    telegramLinkDatabaseService,
    statusAnimator,
    statusAnimation,
    lastMessageLanguageStore,
  };
};

describe('WebhookConsumer', () => {
  it('transcribes a voice note and buffers the transcript into the debounce window (Story 14a)', async () => {
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

    // STT still runs BEFORE buffering (ADR 0042) so the voice note coalesces by
    // its transcript exactly like a text message.
    expect(harness.connector.fetchMedia).toHaveBeenCalledWith(normalized.media);
    expect(harness.stt.transcribe).toHaveBeenCalledTimes(1);
    expect(harness.debounceCoordinator.buffer).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        text: 'move my 3pm to 4',
        kind: InboundKind.Voice,
        vendorChatId: 'chat-1',
      }),
    );
    // A fresh simple message no longer runs the turn immediately — it is buffered.
    expect(
      harness.debounceCoordinator.runAnswerExclusive,
    ).not.toHaveBeenCalled();
  });

  it('surfaces the STT-reported language into the debounce buffer (v2 Task 4 / ADR 0051 — was discarded)', async () => {
    const normalized: NormalizedInboundMessage = {
      kind: InboundKind.Voice,
      vendorChatId: 'chat-1',
      vendorUserId: 'u-1',
      dedupeId: '109',
      languageCode: 'en',
      media: { vendorFileId: 'file-1', mimeHint: 'audio/ogg' },
    };
    const harness = buildConsumer(normalized);

    harness.connector.fetchMedia.mockResolvedValue({
      bytes: Buffer.from([1, 2, 3]),
      mimeType: 'audio/ogg',
    });
    // The STT model reports the spoken language — it must be threaded onward so the
    // post-STT loading words switch to it (previously the language was dropped).
    harness.stt.transcribe.mockResolvedValue({
      text: 'перенеси встречу на завтра',
      language: 'ru',
    });

    await harness.consumer.process(buildJob('{"update_id":109}'));

    expect(harness.debounceCoordinator.buffer).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        text: 'перенеси встречу на завтра',
        kind: InboundKind.Voice,
        sttLanguage: 'ru',
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
    expect(
      harness.debounceCoordinator.runAnswerExclusive,
    ).not.toHaveBeenCalled();
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
    expect(
      harness.debounceCoordinator.runAnswerExclusive,
    ).not.toHaveBeenCalled();
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
    expect(
      harness.debounceCoordinator.runAnswerExclusive,
    ).not.toHaveBeenCalled();
  });

  it('buffers a text message into the debounce window for a linked user (Story 14a)', async () => {
    const normalized: NormalizedInboundMessage = {
      kind: InboundKind.Text,
      vendorChatId: 'chat-1',
      vendorUserId: 'u-1',
      dedupeId: '104',
      text: 'what is on tomorrow?',
    };
    const harness = buildConsumer(normalized);

    await harness.consumer.process(buildJob('{"update_id":104}'));

    expect(harness.debounceCoordinator.buffer).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        text: 'what is on tomorrow?',
        kind: InboundKind.Text,
        correlationId: 'cid-1',
      }),
    );
    expect(
      harness.debounceCoordinator.runAnswerExclusive,
    ).not.toHaveBeenCalled();
  });

  it('routes a pending-question answer through the per-user lock via runAnswerExclusive (NOT buffered/coalesced, FIX 2)', async () => {
    const normalized: NormalizedInboundMessage = {
      kind: InboundKind.Text,
      vendorChatId: 'chat-1',
      vendorUserId: 'u-1',
      dedupeId: '107',
      text: 'Tuesday it is',
    };
    // A pending ask_user question is open → the free-text reply is an ANSWER flow.
    // It must NOT be buffered/coalesced, but it MUST run under the same per-user
    // lock as a simple-message turn (FIX 2), so it dispatches to the coordinator's
    // runAnswerExclusive (which holds the lock + queues-after when busy), never the
    // turn runner directly (which would run lock-free, racing a simple-message turn).
    const harness = buildConsumer(normalized, { hasPendingQuestion: true });

    await harness.consumer.process(buildJob('{"update_id":107}'));

    expect(harness.debounceCoordinator.runAnswerExclusive).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user-1' }),
      expect.objectContaining({
        text: 'Tuesday it is',
        origin: 'answer_text',
      }),
    );
    expect(harness.debounceCoordinator.buffer).not.toHaveBeenCalled();
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
    // A content command (/today) is NOT a (re)engagement entry point, so it must
    // NOT dock the persistent reply keyboard (Story 16 / ADR 0045).
    expect(
      harness.keyboardActionService.showMainKeyboard,
    ).not.toHaveBeenCalled();
  });

  it('docks the persistent main reply keyboard after /start (Story 16 entry point)', async () => {
    const normalized: NormalizedInboundMessage = {
      kind: InboundKind.Command,
      vendorChatId: 'chat-1',
      vendorUserId: 'u-1',
      dedupeId: '106',
      command: 'start',
      commandArgs: [],
    };
    const harness = buildConsumer(normalized);

    await harness.consumer.process(buildJob('{"update_id":106}'));

    expect(harness.assistantService.handleCommand).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user-1' }),
      expect.objectContaining({ command: 'start', correlationId: 'cid-1' }),
    );
    // /start (re)engagement docks the main keyboard + marks it the active surface,
    // so [Today's schedule] [Next week] [Settings] appear and a label tap routes.
    expect(harness.keyboardActionService.showMainKeyboard).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user-1' }),
      'chat-1',
      expect.any(String),
      'cid-1',
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

    // A simple message now flows through the debounce coordinator's buffer; a
    // buffering fault must still release the dedupe guard and rethrow (the
    // consumer is attempts:1 — failing loud beats a silent drop).
    harness.debounceCoordinator.buffer.mockRejectedValue(new Error('db down'));

    await expect(
      harness.consumer.process(buildJob('{"update_id":106}')),
    ).rejects.toThrow(/db down/);
    expect(harness.redis.del).toHaveBeenCalledTimes(1);
  });
});
