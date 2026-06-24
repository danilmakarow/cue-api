import { StatusAnimatorService } from './status-animator.service';
import { StatusSession, StatusSessionPhase } from './status-session.store';
import {
  ChatAction,
  ChatType,
  OutboundFormat,
} from '@/modules/external-vendor/external-vendor.types';

/** Loading-word rotation interval (ms) the fake AssistantConfig hands the animator. */
const WORD_INTERVAL_MS = 5000;

/** Draft-update cap (updates/second) the fake AssistantConfig hands the animator. */
const DRAFT_UPDATES_PER_SECOND = 4;

/**
 * Builds a StatusSessionStore fake (ADR 0059). `open` is idempotent: the SET-NX
 * winner gets a fresh session echoing back the seeded `draftId` (private) /
 * `vendorMessageId` (non-private), while a configured `existingMessageId`
 * simulates a replay/lost-race that already carries a posted message id (so the
 * non-private animator must NOT post again). `failOpen` makes `open` reject to
 * exercise the degrade path.
 */
const buildSessionStore = (
  options: { failOpen?: boolean; existingMessageId?: string } = {},
) => {
  const clear = jest.fn().mockResolvedValue(undefined);
  const advancePhase = jest.fn().mockResolvedValue(undefined);
  const open = jest.fn(async (input): Promise<StatusSession> => {
    if (options.failOpen) {
      throw new Error('redis down');
    }

    return {
      vendorChatId: input.vendorChatId,
      turnId: input.turnId,
      chatType: input.chatType,
      vendorMessageId: options.existingMessageId,
      draftId: input.seedDraftId,
      locale: input.locale,
      phase: StatusSessionPhase.Thinking,
    };
  });

  return { open, clear, advancePhase };
};

/** Builds a vendor connector fake covering the draft / send / edit / chat-action surface. */
const buildVendor = () => ({
  sendMessage: jest.fn().mockResolvedValue({ vendorMessageId: 'status-msg-1' }),
  sendMessageDraft: jest.fn().mockResolvedValue(undefined),
  editMessageText: jest.fn().mockResolvedValue(undefined),
  deleteMessage: jest.fn().mockResolvedValue(undefined),
  sendChatAction: jest.fn().mockResolvedValue(undefined),
});

/** Builds an AssistantConfig fake exposing the two knobs the animator reads. */
const buildConfig = () => ({
  statusWordIntervalMs: WORD_INTERVAL_MS,
  draftUpdatesPerSecond: DRAFT_UPDATES_PER_SECOND,
});

const buildAnimator = (
  options: { failOpen?: boolean; existingMessageId?: string } = {},
) => {
  const vendor = buildVendor();
  const sessions = buildSessionStore({
    failOpen: options.failOpen,
    existingMessageId: options.existingMessageId,
  });
  const config = buildConfig();
  const service = new StatusAnimatorService(
    vendor as never,
    sessions as never,
    config as never,
  );

  return { service, vendor, sessions, config };
};

/** The text of the most recent sendMessageDraft call. */
const lastDraftText = (vendor: ReturnType<typeof buildVendor>): string =>
  vendor.sendMessageDraft.mock.calls.at(-1)?.[1].text as string;

describe('StatusAnimatorService — private chats (native drafts, ADR 0059)', () => {
  it('opens an ephemeral draft with a stable NON-ZERO draftId and a plain loading word (no <pre>/<blockquote>)', async () => {
    const { service, vendor } = buildAnimator();

    const animation = await service.begin({
      vendorChatId: 'chat-1',
      turnId: 'turn-1',
      chatType: ChatType.Private,
      languageCode: 'en',
    });

    // THINKING: one sendMessageDraft, no real sendMessage (the draft is the surface).
    expect(vendor.sendMessageDraft).toHaveBeenCalledTimes(1);
    expect(vendor.sendMessage).not.toHaveBeenCalled();

    const [target, draft] = vendor.sendMessageDraft.mock.calls[0];

    expect(target).toEqual(
      expect.objectContaining({
        vendorChatId: 'chat-1',
        chatType: ChatType.Private,
      }),
    );
    // A stable non-zero integer draft id derived from the turn id.
    expect(Number.isInteger(draft.draftId)).toBe(true);
    expect(draft.draftId).not.toBe(0);
    expect(draft.format).toBe(OutboundFormat.Html);
    // Plain loading word — NOT a <pre> spinner frame, NOT a blockquote.
    expect(draft.text).toMatch(/^[A-Za-z]+$/);
    expect(draft.text).not.toContain('<pre>');
    expect(draft.text).not.toContain('<blockquote>');

    await animation.finalize();
  });

  it('messageId is ALWAYS null for a private turn (the reply sends a fresh final message)', async () => {
    const { service } = buildAnimator();

    const animation = await service.begin({
      vendorChatId: 'chat-1',
      turnId: 'turn-1',
      chatType: ChatType.Private,
      languageCode: 'en',
    });

    // No real status message exists — the draft is ephemeral, so the final reply
    // is a fresh sendMessage (messageId null routes the presenter to a fresh send).
    expect(animation.messageId).toBeNull();

    await animation.finalize();
  });

  it('reuses the SAME draftId across the turn (open and a later update share it)', async () => {
    const { service, vendor } = buildAnimator();

    const animation = await service.begin({
      vendorChatId: 'chat-1',
      turnId: 'turn-stable',
      chatType: ChatType.Private,
      languageCode: 'en',
    });

    await animation.showRecap('Checking Thursday');

    const ids = vendor.sendMessageDraft.mock.calls.map(
      (call) => call[1].draftId,
    );

    // Every draft re-call for the turn carries the identical id (Telegram animates
    // the diffs natively only when the id is reused).
    expect(new Set(ids).size).toBe(1);

    await animation.finalize();
  });

  it('showVoiceListening fires record_voice and sends a PLAIN listening draft (no blockquote/<pre>)', async () => {
    const { service, vendor } = buildAnimator();

    const animation = await service.begin({
      vendorChatId: 'chat-1',
      turnId: 'turn-1',
      chatType: ChatType.Private,
      languageCode: 'ru',
    });

    await animation.showVoiceListening();

    expect(vendor.sendChatAction).toHaveBeenCalledWith(
      expect.objectContaining({ vendorChatId: 'chat-1' }),
      ChatAction.RecordVoice,
    );

    // The voice line is a plain draft — one of the ru variants, not wrapped.
    const text = lastDraftText(vendor);

    expect(text).not.toContain('<pre>');
    expect(text).not.toContain('<blockquote>');
    expect([
      'Слушаю вас',
      'Обратилась в слух',
      'Ловлю каждое слово',
      'Вся внимание',
      'Внимаю каждому слову',
    ]).toContain(text);

    await animation.finalize();
  });

  it('startLoading advances to Working, fires typing, and ROTATES the loading word via fresh draft sends', async () => {
    jest.useFakeTimers();

    try {
      const { service, vendor, sessions } = buildAnimator();

      const animation = await service.begin({
        vendorChatId: 'chat-1',
        turnId: 'turn-1',
        chatType: ChatType.Private,
        languageCode: 'en',
      });

      const draftsBeforeLoading = vendor.sendMessageDraft.mock.calls.length;

      await animation.startLoading();

      expect(sessions.advancePhase).toHaveBeenCalledWith(
        'chat-1',
        'turn-1',
        StatusSessionPhase.Working,
      );
      expect(vendor.sendChatAction).toHaveBeenCalledWith(
        expect.objectContaining({ vendorChatId: 'chat-1' }),
        ChatAction.Typing,
      );

      // The rotation now fires further DRAFT sends (each a keepalive), NOT edits.
      await jest.advanceTimersByTimeAsync(WORD_INTERVAL_MS * 3);

      expect(vendor.sendMessageDraft.mock.calls.length).toBeGreaterThan(
        draftsBeforeLoading,
      );
      expect(vendor.editMessageText).not.toHaveBeenCalled();

      // The rotated frames are bare loading words (plain text).
      expect(lastDraftText(vendor)).toMatch(/^[A-Za-z]+$/);

      await animation.finalize();
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });

  it('the rotation swaps to DIFFERENT loading words across ticks (never the same back-to-back)', async () => {
    jest.useFakeTimers();

    try {
      const { service, vendor } = buildAnimator();

      const animation = await service.begin({
        vendorChatId: 'chat-1',
        turnId: 'turn-1',
        chatType: ChatType.Private,
        languageCode: 'en',
      });

      await animation.startLoading();
      await jest.advanceTimersByTimeAsync(WORD_INTERVAL_MS * 5);

      const words = vendor.sendMessageDraft.mock.calls.map(
        (call) => call[1].text as string,
      );

      // No two consecutive draft words are identical (anti-repeat rotation).
      for (let index = 1; index < words.length; index += 1) {
        expect(words[index]).not.toBe(words[index - 1]);
      }

      // And more than one distinct word appeared over five rotations.
      expect(new Set(words).size).toBeGreaterThan(1);

      await animation.finalize();
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });

  it('showRecap sends a draft that is ONLY the BARE recap text — NO blockquote, NO loading word above it', async () => {
    const { service, vendor } = buildAnimator();

    const animation = await service.begin({
      vendorChatId: 'chat-1',
      turnId: 'turn-1',
      chatType: ChatType.Private,
      languageCode: 'en',
    });

    await animation.showRecap('Checking Thursday afternoon');

    const [target, draft] = vendor.sendMessageDraft.mock.calls.at(-1)!;

    expect(target).toEqual(expect.objectContaining({ vendorChatId: 'chat-1' }));
    expect(draft.format).toBe(OutboundFormat.Html);
    // The draft is EXACTLY the bare recap — no blockquote/pre wrapper, no word above.
    expect(draft.text).toBe('Checking Thursday afternoon');
    expect(draft.text).not.toContain('<blockquote>');
    expect(draft.text).not.toContain('<pre>');

    await animation.finalize();
  });

  it('showRecap STRIPS trailing punctuation (a comma) from the bare recap before escaping', async () => {
    const { service, vendor } = buildAnimator();

    const animation = await service.begin({
      vendorChatId: 'chat-1',
      turnId: 'turn-1',
      chatType: ChatType.Private,
      languageCode: 'en',
    });

    // A model-authored recap that ends in a comma renders bare (Telegram adds its
    // own shimmer) — the trailing comma is stripped before the bare-text escape.
    await animation.showRecap('Checking Thursday,');

    expect(lastDraftText(vendor)).toBe('Checking Thursday');

    await animation.finalize();
  });

  it('showRecap HTML-escapes the bare recap text', async () => {
    const { service, vendor } = buildAnimator();

    const animation = await service.begin({
      vendorChatId: 'chat-1',
      turnId: 'turn-1',
      chatType: ChatType.Private,
      languageCode: 'en',
    });

    await animation.showRecap('a < b & c');

    expect(lastDraftText(vendor)).toBe('a &lt; b &amp; c');

    await animation.finalize();
  });

  it('showRecap is a no-op for empty text and once finalized', async () => {
    const { service, vendor } = buildAnimator();

    const animation = await service.begin({
      vendorChatId: 'chat-1',
      turnId: 'turn-1',
      chatType: ChatType.Private,
      languageCode: 'en',
    });

    const draftsAfterOpen = vendor.sendMessageDraft.mock.calls.length;

    await animation.showRecap('');
    expect(vendor.sendMessageDraft.mock.calls.length).toBe(draftsAfterOpen);

    await animation.finalize();
    await animation.showRecap('too late');
    expect(vendor.sendMessageDraft.mock.calls.length).toBe(draftsAfterOpen);
  });

  describe('streamAnswer (token streaming onto the draft)', () => {
    it('STOPS the loading-word rotation on the first token so no late word overwrites the answer', async () => {
      jest.useFakeTimers();

      try {
        const { service, vendor } = buildAnimator();

        const animation = await service.begin({
          vendorChatId: 'chat-1',
          turnId: 'turn-1',
          chatType: ChatType.Private,
          languageCode: 'en',
        });

        await animation.startLoading();
        await jest.advanceTimersByTimeAsync(WORD_INTERVAL_MS * 2);

        animation.streamAnswer('Hello');
        // Drain the throttle so the answer flush (possibly a trailing flush) lands.
        await jest.advanceTimersByTimeAsync(WORD_INTERVAL_MS);

        // The answer is now the surface; advancing further triggers NO rotation
        // word — every subsequent draft is the answer text, never a loading word.
        await jest.advanceTimersByTimeAsync(WORD_INTERVAL_MS * 5);

        // The streamed answer is the last draft and is the bare escaped text (no
        // rotation word reverted it).
        expect(lastDraftText(vendor)).toBe('Hello');

        await animation.finalize();
      } finally {
        jest.clearAllTimers();
        jest.useRealTimers();
      }
    });

    it('streams the answer as bare HTML-escaped PLAIN text (no <pre>/<blockquote>) with OutboundFormat.Html', async () => {
      const { service, vendor } = buildAnimator();

      const animation = await service.begin({
        vendorChatId: 'chat-1',
        turnId: 'turn-1',
        chatType: ChatType.Private,
        languageCode: 'en',
      });

      animation.streamAnswer('a < b & c');
      await animation.settle();

      const draft = vendor.sendMessageDraft.mock.calls.at(-1)?.[1];

      expect(draft.text).toBe('a &lt; b &amp; c');
      expect(draft.text).not.toContain('<pre>');
      expect(draft.text).not.toContain('<blockquote>');
      expect(draft.format).toBe(OutboundFormat.Html);

      await animation.finalize();
    });

    it('THROTTLES rapid snapshots through the DraftThrottle (coalesces to far fewer sends)', async () => {
      jest.useFakeTimers();

      try {
        const { service, vendor } = buildAnimator();

        const animation = await service.begin({
          vendorChatId: 'chat-1',
          turnId: 'turn-1',
          chatType: ChatType.Private,
          languageCode: 'en',
        });

        const draftsBefore = vendor.sendMessageDraft.mock.calls.length;

        // 20 snapshots inside one throttle window: the first flushes (leading
        // edge), the rest coalesce away to a single trailing flush.
        for (let index = 1; index <= 20; index += 1) {
          animation.streamAnswer('word '.repeat(index).trim());
        }

        await jest.advanceTimersByTimeAsync(0);

        const streamed =
          vendor.sendMessageDraft.mock.calls.length - draftsBefore;

        // Far fewer than 20 (leading edge only inside the window).
        expect(streamed).toBe(1);

        await animation.finalize();
      } finally {
        jest.clearAllTimers();
        jest.useRealTimers();
      }
    });

    it('settle FLUSHES the latest coalesced snapshot so it reaches the draft before the reply', async () => {
      const { service, vendor } = buildAnimator();

      const animation = await service.begin({
        vendorChatId: 'chat-1',
        turnId: 'turn-1',
        chatType: ChatType.Private,
        languageCode: 'en',
      });

      animation.streamAnswer('a');
      animation.streamAnswer('a b');
      animation.streamAnswer('a b c');

      await animation.settle();

      expect(lastDraftText(vendor)).toBe('a b c');

      await animation.finalize();
    });

    it('is a no-op for empty text and once finalized', async () => {
      const { service, vendor } = buildAnimator();

      const animation = await service.begin({
        vendorChatId: 'chat-1',
        turnId: 'turn-1',
        chatType: ChatType.Private,
        languageCode: 'en',
      });

      const draftsAfterOpen = vendor.sendMessageDraft.mock.calls.length;

      animation.streamAnswer('');
      await animation.settle();
      expect(vendor.sendMessageDraft.mock.calls.length).toBe(draftsAfterOpen);

      await animation.finalize();
      animation.streamAnswer('too late');
      await animation.settle();
      expect(vendor.sendMessageDraft.mock.calls.length).toBe(draftsAfterOpen);
    });
  });

  describe('settleDraftTo (clear_draft equivalent — replaces the draft preview before the real send)', () => {
    it('pushes ONE final draft frame equal to the (escaped) given text, awaited', async () => {
      const { service, vendor } = buildAnimator();

      const animation = await service.begin({
        vendorChatId: 'chat-1',
        turnId: 'turn-1',
        chatType: ChatType.Private,
        languageCode: 'en',
      });

      const draftsBefore = vendor.sendMessageDraft.mock.calls.length;

      await animation.settleDraftTo('When works for you? <3');

      // Exactly one further draft frame, carrying the escaped question text.
      expect(vendor.sendMessageDraft.mock.calls.length).toBe(draftsBefore + 1);

      const draft = vendor.sendMessageDraft.mock.calls.at(-1)?.[1];

      expect(draft.text).toBe('When works for you? &lt;3');
      expect(draft.format).toBe(OutboundFormat.Html);

      await animation.finalize();
    });

    it('STOPS the word rotation so no later loading word overwrites the settled frame', async () => {
      jest.useFakeTimers();

      try {
        const { service, vendor } = buildAnimator();

        const animation = await service.begin({
          vendorChatId: 'chat-1',
          turnId: 'turn-1',
          chatType: ChatType.Private,
          languageCode: 'en',
        });

        await animation.startLoading();
        await jest.advanceTimersByTimeAsync(WORD_INTERVAL_MS * 2);

        await animation.settleDraftTo('Which day?');

        const draftsAfterSettle = vendor.sendMessageDraft.mock.calls.length;

        // The rotation is dead — advancing the clock pushes no further frame.
        await jest.advanceTimersByTimeAsync(WORD_INTERVAL_MS * 5);
        expect(vendor.sendMessageDraft.mock.calls.length).toBe(
          draftsAfterSettle,
        );
        expect(lastDraftText(vendor)).toBe('Which day?');

        await animation.finalize();
      } finally {
        jest.clearAllTimers();
        jest.useRealTimers();
      }
    });

    it('degrades (never throws) when the settle draft send fails', async () => {
      const { service, vendor } = buildAnimator();

      const animation = await service.begin({
        vendorChatId: 'chat-1',
        turnId: 'turn-1',
        chatType: ChatType.Private,
        languageCode: 'en',
      });

      vendor.sendMessageDraft.mockRejectedValue(new Error('telegram 500'));

      await expect(
        animation.settleDraftTo('Which day?'),
      ).resolves.toBeUndefined();

      await animation.finalize();
    });
  });

  it('finalize stops the rotation, clears the session, and does NOT delete the draft (it self-expires)', async () => {
    jest.useFakeTimers();

    try {
      const { service, vendor, sessions } = buildAnimator();

      const animation = await service.begin({
        vendorChatId: 'chat-1',
        turnId: 'turn-1',
        chatType: ChatType.Private,
        languageCode: 'en',
      });

      await animation.startLoading();
      await jest.advanceTimersByTimeAsync(WORD_INTERVAL_MS * 2);

      await animation.finalize();

      const draftsAfterFinalize = vendor.sendMessageDraft.mock.calls.length;

      // No queued rotation frame survives finalize.
      await jest.advanceTimersByTimeAsync(WORD_INTERVAL_MS * 5);
      expect(vendor.sendMessageDraft.mock.calls.length).toBe(
        draftsAfterFinalize,
      );

      // The Redis session is cleared; the draft is never deleted (no clear method).
      expect(sessions.clear).toHaveBeenCalledWith('chat-1', 'turn-1');
      expect(vendor.deleteMessage).not.toHaveBeenCalled();
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });

  it('degrades (never throws) when the draft send fails', async () => {
    const { service, vendor } = buildAnimator();

    vendor.sendMessageDraft.mockRejectedValue(new Error('telegram 500'));

    const animation = await service.begin({
      vendorChatId: 'chat-1',
      turnId: 'turn-1',
      chatType: ChatType.Private,
      languageCode: 'en',
    });

    await expect(animation.showRecap('progress')).resolves.toBeUndefined();
    await expect(animation.finalize()).resolves.toBeUndefined();
  });
});

describe('StatusAnimatorService — non-private chats (editMessageText fallback, ADR 0053)', () => {
  it('posts ONE real message (NO draft) and exposes its id via .messageId', async () => {
    const { service, vendor } = buildAnimator();

    const animation = await service.begin({
      vendorChatId: 'group-1',
      turnId: 'turn-1',
      chatType: ChatType.Group,
      languageCode: 'en',
    });

    // A group uses the real-message fallback — no draft is ever sent.
    expect(vendor.sendMessageDraft).not.toHaveBeenCalled();
    expect(vendor.sendMessage).toHaveBeenCalledTimes(1);

    const [target, message] = vendor.sendMessage.mock.calls[0];

    expect(target).toEqual(
      expect.objectContaining({
        vendorChatId: 'group-1',
        chatType: ChatType.Group,
      }),
    );
    expect(message.format).toBe(OutboundFormat.Html);
    // A <pre>-wrapped loading word (no spinner glyph anymore).
    expect(message.text).toMatch(/^<pre>[A-Za-z]+<\/pre>$/);

    // The real id is exposed so the reply MORPHS this message (non-private).
    expect(animation.messageId).toBe('status-msg-1');

    await animation.finalize();
  });

  it('showRecap EDITS the one real message with a <pre> recap (no draft)', async () => {
    const { service, vendor } = buildAnimator();

    const animation = await service.begin({
      vendorChatId: 'group-1',
      turnId: 'turn-1',
      chatType: ChatType.Group,
      languageCode: 'en',
    });

    await animation.showRecap('Checking Thursday afternoon');

    expect(vendor.sendMessageDraft).not.toHaveBeenCalled();
    expect(vendor.editMessageText).toHaveBeenCalledWith(
      expect.objectContaining({ vendorChatId: 'group-1' }),
      expect.objectContaining({
        vendorMessageId: 'status-msg-1',
        text: '<pre>Checking Thursday afternoon</pre>',
        format: OutboundFormat.Html,
      }),
    );

    await animation.finalize();
  });

  it('showVoiceListening EDITS the one real message with the <pre>-wrapped voice line', async () => {
    const { service, vendor } = buildAnimator();

    const animation = await service.begin({
      vendorChatId: 'group-1',
      turnId: 'turn-1',
      chatType: ChatType.Group,
      languageCode: 'ru',
    });

    await animation.showVoiceListening();

    const edit = vendor.editMessageText.mock.calls.at(-1)?.[1];

    expect(edit.vendorMessageId).toBe('status-msg-1');
    expect(edit.format).toBe(OutboundFormat.Html);
    expect(edit.text).toMatch(/^<pre>.+<\/pre>$/);
    expect(vendor.sendMessageDraft).not.toHaveBeenCalled();

    await animation.finalize();
  });

  it('streams the answer by EDITING the one real message (no draft)', async () => {
    const { service, vendor } = buildAnimator();

    const animation = await service.begin({
      vendorChatId: 'group-1',
      turnId: 'turn-1',
      chatType: ChatType.Group,
      languageCode: 'en',
    });

    animation.streamAnswer('a < b');
    await animation.settle();

    expect(vendor.sendMessageDraft).not.toHaveBeenCalled();
    expect(vendor.editMessageText).toHaveBeenLastCalledWith(
      expect.objectContaining({ vendorChatId: 'group-1' }),
      expect.objectContaining({
        vendorMessageId: 'status-msg-1',
        text: 'a &lt; b',
        format: OutboundFormat.Html,
      }),
    );

    await animation.finalize();
  });

  it('does NOT post again on an idempotent re-open whose session already carries a message id', async () => {
    const { service, vendor } = buildAnimator({
      existingMessageId: 'prior-99',
    });

    const animation = await service.begin({
      vendorChatId: 'group-1',
      turnId: 'turn-1',
      chatType: ChatType.Group,
      languageCode: 'en',
    });

    expect(vendor.sendMessage).not.toHaveBeenCalled();
    expect(animation.messageId).toBe('prior-99');

    await animation.finalize();
  });

  it('messageId is null when the initial non-private send failed', async () => {
    const { service, vendor } = buildAnimator();

    vendor.sendMessage.mockRejectedValueOnce(new Error('telegram 500'));

    const animation = await service.begin({
      vendorChatId: 'group-1',
      turnId: 'turn-1',
      chatType: ChatType.Group,
      languageCode: 'en',
    });

    expect(vendor.sendMessage).toHaveBeenCalledTimes(1);
    expect(animation.messageId).toBeNull();

    await animation.finalize();
  });

  it('settleDraftTo is a NO-OP for a non-private turn (the morph path replaces its message)', async () => {
    const { service, vendor } = buildAnimator();

    const animation = await service.begin({
      vendorChatId: 'group-1',
      turnId: 'turn-1',
      chatType: ChatType.Group,
      languageCode: 'en',
    });

    await animation.settleDraftTo('Which day?');

    // No draft is ever sent for a group; settleDraftTo neither sends nor edits.
    expect(vendor.sendMessageDraft).not.toHaveBeenCalled();

    await animation.finalize();
  });
});

describe('StatusAnimatorService — degrade + locale resolution', () => {
  it('degrades (never throws) and proceeds when open fails', async () => {
    const { service, vendor, sessions } = buildAnimator({ failOpen: true });

    const animation = await service.begin({
      vendorChatId: 'chat-1',
      turnId: 'turn-1',
      chatType: ChatType.Private,
      languageCode: 'en',
    });

    // No surface was posted (session open failed) but no throw escaped.
    expect(vendor.sendMessageDraft).not.toHaveBeenCalled();
    expect(animation.messageId).toBeNull();

    await expect(animation.startLoading()).resolves.toBeUndefined();
    await expect(animation.showRecap('progress')).resolves.toBeUndefined();
    await expect(animation.finalize()).resolves.toBeUndefined();
    expect(sessions.clear).toHaveBeenCalledTimes(1);
  });

  it('degrades (never throws) when clearing the session fails', async () => {
    const { service, sessions } = buildAnimator();

    const animation = await service.begin({
      vendorChatId: 'chat-1',
      turnId: 'turn-1',
      chatType: ChatType.Private,
      languageCode: 'en',
    });

    sessions.clear.mockRejectedValue(new Error('redis down'));

    await expect(animation.finalize()).resolves.toBeUndefined();
  });

  describe('loading-word locale resolution (v2 Task 4 / ADR 0051)', () => {
    // The loading word is random within a locale, so we assert its SCRIPT: en is
    // all-Latin, ru/uk all-Cyrillic. (ru vs uk is covered by status-phrases.spec.)
    const CYRILLIC = /[А-яЁёІіЇїЄєҐґ]/;

    let service: StatusAnimatorService;
    let vendor: ReturnType<typeof buildVendor>;

    beforeEach(() => {
      const built = buildAnimator();

      service = built.service;
      vendor = built.vendor;
    });

    /** Begins a private turn and returns the bare loading word from the opening draft. */
    const openingWord = async (
      input: Parameters<typeof service.begin>[0],
    ): Promise<string> => {
      const animation = await service.begin(input);
      const word = lastDraftText(vendor);

      await animation.finalize();

      return word;
    };

    it('drives the loading word from the MESSAGE text, OVERRIDING an English language_code (the bug fix)', async () => {
      const word = await openingWord({
        vendorChatId: 'chat-1',
        turnId: 'turn-1',
        chatType: ChatType.Private,
        languageCode: 'en',
        messageText: 'перенеси встречу на завтра',
      });

      expect(word).toMatch(CYRILLIC);
    });

    it('detects a Ukrainian message (distinctive і) and shows a Cyrillic (uk) word', async () => {
      const word = await openingWord({
        vendorChatId: 'chat-1',
        turnId: 'turn-1',
        chatType: ChatType.Private,
        languageCode: 'en',
        messageText: 'перенеси зустріч на завтра',
      });

      expect(word).toMatch(CYRILLIC);
    });

    it('falls back to the language_code when the message text is inconclusive', async () => {
      const word = await openingWord({
        vendorChatId: 'chat-1',
        turnId: 'turn-1',
        chatType: ChatType.Private,
        languageCode: 'ru',
        messageText: '15:30 👍',
      });

      expect(word).toMatch(CYRILLIC);
    });

    it('defaults to en (Latin) when the message is inconclusive AND the language_code is unsupported', async () => {
      const word = await openingWord({
        vendorChatId: 'chat-1',
        turnId: 'turn-1',
        chatType: ChatType.Private,
        languageCode: 'fr',
        messageText: '123',
      });

      expect(word).not.toMatch(CYRILLIC);
    });

    it('voice pre-STT uses the language_code for the plain Listening draft (no text yet)', async () => {
      const animation = await service.begin({
        vendorChatId: 'chat-1',
        turnId: 'turn-1',
        chatType: ChatType.Private,
        languageCode: 'uk',
      });

      await animation.showVoiceListening();

      const line = lastDraftText(vendor);

      // A Ukrainian voice variant (from language_code), as a plain draft.
      expect(line).toMatch(CYRILLIC);
      expect(line).not.toContain('<pre>');
      expect(line).not.toContain('<blockquote>');

      await animation.finalize();
    });

    it('voice pre-STT borrows the prior-turn locale when language_code is unsupported (R2 / ADR 0055)', async () => {
      const animation = await service.begin({
        vendorChatId: 'chat-1',
        turnId: 'turn-1',
        chatType: ChatType.Private,
        languageCode: 'fr',
        priorLocale: 'ru',
      });

      await animation.showVoiceListening();

      expect(lastDraftText(vendor)).toMatch(CYRILLIC);

      await animation.finalize();
    });

    it('voice post-STT drives the loading word from the STT-reported language (over an English code)', async () => {
      const word = await openingWord({
        vendorChatId: 'chat-1',
        turnId: 'turn-1',
        chatType: ChatType.Private,
        languageCode: 'en',
        sttLanguage: 'ru',
        messageText: 'move my meeting',
      });

      expect(word).toMatch(CYRILLIC);
    });
  });
});
