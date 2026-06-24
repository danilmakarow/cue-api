import { StatusAnimatorService } from './status-animator.service';
import { SPINNER_FRAMES } from './status-phrases';
import { StatusSession, StatusSessionPhase } from './status-session.store';
import {
  ChatAction,
  ChatType,
  OutboundFormat,
} from '@/modules/external-vendor/external-vendor.types';

/** Spinner tick interval (ms) the fake AssistantConfig hands the animator. */
const SPINNER_INTERVAL_MS = 1000;

/**
 * Builds a StatusSessionStore fake for the ONE-real-message surface (ADR 0053).
 * `open` is idempotent: the SET-NX winner gets a fresh session with NO
 * `vendorMessageId` (so the animator posts the message), while a configured
 * `existingMessageId` simulates a replay/lost-race that already carries a posted
 * message id (so the animator must NOT post again). `clear`/`advancePhase` are
 * spies. `failOpen` makes `open` reject to exercise the degrade path.
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
      locale: input.locale,
      phase: StatusSessionPhase.Thinking,
    };
  });

  return { open, clear, advancePhase };
};

/** Builds a vendor connector fake covering the send / edit / delete / chat-action surface. */
const buildVendor = () => ({
  sendMessage: jest.fn().mockResolvedValue({ vendorMessageId: 'status-msg-1' }),
  editMessageText: jest.fn().mockResolvedValue(undefined),
  deleteMessage: jest.fn().mockResolvedValue(undefined),
  sendChatAction: jest.fn().mockResolvedValue(undefined),
});

/** Builds an AssistantConfig fake exposing only the spinner interval the animator reads. */
const buildConfig = () => ({
  statusSpinnerIntervalMs: SPINNER_INTERVAL_MS,
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

describe('StatusAnimatorService (live status, ADR 0053 — one morphing message)', () => {
  it('posts exactly ONE real message with a loading line on open and exposes its id via .messageId', async () => {
    const { service, vendor } = buildAnimator();

    const animation = await service.begin({
      vendorChatId: 'chat-1',
      turnId: 'turn-1',
      chatType: ChatType.Private,
      languageCode: 'en',
    });

    // open() posts ONE real message (no draft surface anywhere).
    expect(vendor.sendMessage).toHaveBeenCalledTimes(1);

    const [target, message] = vendor.sendMessage.mock.calls[0];

    expect(target).toEqual(expect.objectContaining({ vendorChatId: 'chat-1' }));
    // The loading line is an HTML <pre> code block: the frame-0 spinner glyph +
    // a single localized loading word, NO trailing ellipsis (R1 / ADR 0057).
    expect(message.format).toBe(OutboundFormat.Html);
    expect(message.text).toMatch(
      new RegExp(`^<pre>${SPINNER_FRAMES[0]} [A-Za-z]+</pre>$`),
    );

    // The posted message's id is exposed so the reply can morph the SAME message.
    expect(animation.messageId).toBe('status-msg-1');

    await animation.finalize();
  });

  it('does NOT post again on an idempotent re-open whose session already carries a message id', async () => {
    const { service, vendor } = buildAnimator({
      existingMessageId: 'prior-99',
    });

    const animation = await service.begin({
      vendorChatId: 'chat-1',
      turnId: 'turn-1',
      chatType: ChatType.Private,
      languageCode: 'en',
    });

    // A lost NX race / replay re-reads the existing surface — no second send.
    expect(vendor.sendMessage).not.toHaveBeenCalled();
    expect(animation.messageId).toBe('prior-99');

    await animation.finalize();
  });

  it('messageId is null when the initial send failed', async () => {
    const { service, vendor } = buildAnimator();

    vendor.sendMessage.mockRejectedValueOnce(new Error('telegram 500'));

    const animation = await service.begin({
      vendorChatId: 'chat-1',
      turnId: 'turn-1',
      chatType: ChatType.Private,
      languageCode: 'en',
    });

    // The send was attempted but failed — the surface degraded, id stays null so
    // the reply path sends a fresh message instead of morphing.
    expect(vendor.sendMessage).toHaveBeenCalledTimes(1);
    expect(animation.messageId).toBeNull();

    await animation.finalize();
  });

  it('showVoiceListening fires a record_voice chat action and edits the one message to the localized voice phrase', async () => {
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

    // The voice line is shown by EDITING the one real message (not a new send),
    // wrapped in an HTML <pre> code block (R1 / ADR 0057).
    expect(vendor.editMessageText).toHaveBeenCalledWith(
      expect.objectContaining({ vendorChatId: 'chat-1' }),
      expect.objectContaining({
        vendorMessageId: 'status-msg-1',
        text: '<pre>Слушаю ваш прекрасный голос</pre>',
        format: OutboundFormat.Html,
      }),
    );

    await animation.finalize();
  });

  it('startLoading advances the phase to Working, fires a typing chat action, and ARMS the ASCII spinner (R1 / ADR 0057)', async () => {
    jest.useFakeTimers();

    try {
      const { service, vendor, sessions } = buildAnimator();

      const animation = await service.begin({
        vendorChatId: 'chat-1',
        turnId: 'turn-1',
        chatType: ChatType.Private,
        languageCode: 'en',
      });

      const editsBeforeLoading = vendor.editMessageText.mock.calls.length;
      const sendsBeforeLoading = vendor.sendMessage.mock.calls.length;

      await animation.startLoading();

      // Phase advanced to Working (advisory label) + a one-shot typing hint.
      expect(sessions.advancePhase).toHaveBeenCalledWith(
        'chat-1',
        'turn-1',
        StatusSessionPhase.Working,
      );
      expect(vendor.sendChatAction).toHaveBeenCalledWith(
        expect.objectContaining({ vendorChatId: 'chat-1' }),
        ChatAction.Typing,
      );

      // The spinner now ANIMATES: advancing the clock fires further edits (NOT
      // sends — the one message is edited in place), each an HTML <pre> spinner
      // frame on the captured loading word.
      await jest.advanceTimersByTimeAsync(SPINNER_INTERVAL_MS * 3);

      expect(vendor.editMessageText.mock.calls.length).toBeGreaterThan(
        editsBeforeLoading,
      );
      expect(vendor.sendMessage.mock.calls.length).toBe(sendsBeforeLoading);

      const lastFrame = vendor.editMessageText.mock.calls.at(-1)?.[1];

      expect(lastFrame).toEqual(
        expect.objectContaining({
          vendorMessageId: 'status-msg-1',
          format: OutboundFormat.Html,
        }),
      );
      // A <pre>-wrapped spinner frame: a braille glyph + the loading word.
      expect(lastFrame?.text).toMatch(/^<pre>[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] [A-Za-z]+<\/pre>$/);

      await animation.finalize();
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });

  it('the spinner animates the SAME captured word across ticks (only the frame rotates)', async () => {
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
      await jest.advanceTimersByTimeAsync(SPINNER_INTERVAL_MS * 4);

      /** Recovers the bare loading word from a <pre>-wrapped spinner frame. */
      const wordOfFrame = (text: string): string =>
        text
          .replace(/^<pre>./, '')
          .replace(/<\/pre>$/, '')
          .trim();

      const frameTexts = vendor.editMessageText.mock.calls.map(
        (call) => call[1].text as string,
      );
      const words = new Set(frameTexts.map(wordOfFrame));

      // Every frame animates the one captured word — exactly one distinct word.
      expect(words.size).toBe(1);
      // But the frames themselves differ (the leading glyph rotates).
      expect(new Set(frameTexts).size).toBeGreaterThan(1);

      await animation.finalize();
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });

  it('showRecap STOPS the spinner and edits the one message with a <pre> recap (R1 / ADR 0057)', async () => {
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
      await jest.advanceTimersByTimeAsync(SPINNER_INTERVAL_MS * 2);

      await animation.showRecap('Checking Thursday afternoon');

      // The recap is the LAST edit and is a <pre> HTML code block.
      expect(vendor.editMessageText).toHaveBeenCalledWith(
        expect.objectContaining({ vendorChatId: 'chat-1' }),
        expect.objectContaining({
          vendorMessageId: 'status-msg-1',
          text: '<pre>Checking Thursday afternoon</pre>',
          format: OutboundFormat.Html,
        }),
      );

      const editsAfterRecap = vendor.editMessageText.mock.calls.length;
      const lastAfterRecap = vendor.editMessageText.mock.calls.at(-1)?.[1].text;

      // The spinner is dead: advancing the clock queues NO further frame, so the
      // recap stays the last thing shown.
      await jest.advanceTimersByTimeAsync(SPINNER_INTERVAL_MS * 5);

      expect(vendor.editMessageText.mock.calls.length).toBe(editsAfterRecap);
      expect(vendor.editMessageText.mock.calls.at(-1)?.[1].text).toBe(
        lastAfterRecap,
      );

      await animation.finalize();
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });

  it('settle STOPS the spinner so no late frame lands after the reply morphs (R1 / ADR 0057)', async () => {
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
      await jest.advanceTimersByTimeAsync(SPINNER_INTERVAL_MS * 2);

      await animation.settle();

      const editsAfterSettle = vendor.editMessageText.mock.calls.length;

      // After settle the spinner must be dead — the morph (a separate path) is
      // free to edit the answer without a stray frame reverting it.
      await jest.advanceTimersByTimeAsync(SPINNER_INTERVAL_MS * 5);

      expect(vendor.editMessageText.mock.calls.length).toBe(editsAfterSettle);

      await animation.finalize();
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });

  it('finalize STOPS the spinner so no queued frame survives (R1 / ADR 0057)', async () => {
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
      await jest.advanceTimersByTimeAsync(SPINNER_INTERVAL_MS * 2);

      await animation.finalize();

      const editsAfterFinalize = vendor.editMessageText.mock.calls.length;

      await jest.advanceTimersByTimeAsync(SPINNER_INTERVAL_MS * 5);

      expect(vendor.editMessageText.mock.calls.length).toBe(editsAfterFinalize);
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });

  it('does NOT arm the spinner when the initial send failed (null messageId)', async () => {
    jest.useFakeTimers();

    try {
      const { service, vendor } = buildAnimator();

      vendor.sendMessage.mockRejectedValueOnce(new Error('telegram 500'));

      const animation = await service.begin({
        vendorChatId: 'chat-1',
        turnId: 'turn-1',
        chatType: ChatType.Private,
        languageCode: 'en',
      });

      expect(animation.messageId).toBeNull();

      await animation.startLoading();

      const editsBefore = vendor.editMessageText.mock.calls.length;

      // No surface to animate — ticking the clock must not edit a phantom message.
      await jest.advanceTimersByTimeAsync(SPINNER_INTERVAL_MS * 5);

      expect(vendor.editMessageText.mock.calls.length).toBe(editsBefore);

      await animation.finalize();
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });

  it('showRecap edits the one message via editMessageText with a <pre> recap', async () => {
    const { service, vendor } = buildAnimator();

    const animation = await service.begin({
      vendorChatId: 'chat-1',
      turnId: 'turn-1',
      chatType: ChatType.Private,
      languageCode: 'en',
    });

    await animation.showRecap('Checking Thursday afternoon');

    expect(vendor.editMessageText).toHaveBeenCalledWith(
      expect.objectContaining({ vendorChatId: 'chat-1' }),
      expect.objectContaining({
        vendorMessageId: 'status-msg-1',
        text: '<pre>Checking Thursday afternoon</pre>',
        format: OutboundFormat.Html,
      }),
    );

    await animation.finalize();
  });

  it('showRecap is a no-op for empty text', async () => {
    const { service, vendor } = buildAnimator();

    const animation = await service.begin({
      vendorChatId: 'chat-1',
      turnId: 'turn-1',
      chatType: ChatType.Private,
      languageCode: 'en',
    });

    await animation.showRecap('');

    expect(vendor.editMessageText).not.toHaveBeenCalled();

    await animation.finalize();
  });

  it('showRecap is a no-op once finalized (a late recap never edits the message)', async () => {
    const { service, vendor } = buildAnimator();

    const animation = await service.begin({
      vendorChatId: 'chat-1',
      turnId: 'turn-1',
      chatType: ChatType.Private,
      languageCode: 'en',
    });

    await animation.finalize();

    await animation.showRecap('also too late');

    expect(vendor.editMessageText).not.toHaveBeenCalled();
  });

  it('finalize clears the StatusSession and does NOT touch the message (the reply has morphed it)', async () => {
    const { service, vendor, sessions } = buildAnimator();

    const animation = await service.begin({
      vendorChatId: 'chat-1',
      turnId: 'turn-1',
      chatType: ChatType.Private,
      languageCode: 'en',
    });

    const sendsBeforeFinalize = vendor.sendMessage.mock.calls.length;

    await animation.finalize();

    // Only the Redis session is cleared — the message is left intact (the reply
    // morphed it into the answer). No retract send/edit/delete.
    expect(sessions.clear).toHaveBeenCalledWith('chat-1', 'turn-1');
    expect(vendor.sendMessage.mock.calls.length).toBe(sendsBeforeFinalize);
    expect(vendor.editMessageText).not.toHaveBeenCalled();
    expect(vendor.deleteMessage).not.toHaveBeenCalled();
  });

  it('degrades (never throws) and still allows the turn to proceed when open fails', async () => {
    const { service, vendor, sessions } = buildAnimator({ failOpen: true });

    const animation = await service.begin({
      vendorChatId: 'chat-1',
      turnId: 'turn-1',
      chatType: ChatType.Private,
      languageCode: 'en',
    });

    // No surface was posted (session open failed) but no throw escaped, and no id.
    expect(vendor.sendMessage).not.toHaveBeenCalled();
    expect(animation.messageId).toBeNull();

    // startLoading / showRecap / finalize are likewise safe no-ops.
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
    // The loading word is picked at random from the locale's vocabulary, so a
    // single open's exact word is not deterministic. We instead assert the word's
    // SCRIPT, which is decisive: the en vocabulary is all-Latin while the ru/uk
    // vocabularies are all-Cyrillic. (ru vs uk both being Cyrillic is covered by
    // the pure status-phrases.spec.ts unit tests on the resolver chain.)
    const CYRILLIC = /[А-яЁёІіЇїЄєҐґ]/;

    /**
     * Recovers the bare loading word from the posted initial line: a <pre>-wrapped
     * frame-0 spinner glyph + the word (R1 / ADR 0057). Strips the <pre> wrapper
     * and the leading spinner glyph + space.
     */
    const wordOf = (text: string): string =>
      text
        .replace(/^<pre>/, '')
        .replace(/<\/pre>$/, '')
        .replace(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s/, '');

    /** Begins a turn and returns the bare loading word from the posted message. */
    const openingWord = async (
      input: Parameters<typeof service.begin>[0],
    ): Promise<string> => {
      const animation = await service.begin(input);

      const word = wordOf(vendor.sendMessage.mock.calls.at(-1)?.[1].text ?? '');

      await animation.finalize();

      return word;
    };

    let service: StatusAnimatorService;
    let vendor: ReturnType<typeof buildVendor>;

    beforeEach(() => {
      const built = buildAnimator();

      service = built.service;
      vendor = built.vendor;
    });

    it('drives the loading word from the MESSAGE text, OVERRIDING an English language_code (the bug fix)', async () => {
      // The user writes Russian but their Telegram language_code is English — the
      // message text must win so the loading word is Cyrillic (ru), not Latin (en).
      const word = await openingWord({
        vendorChatId: 'chat-1',
        turnId: 'turn-1',
        chatType: ChatType.Private,
        languageCode: 'en',
        messageText: 'перенеси встречу на завтра',
      });

      expect(word).toMatch(CYRILLIC);
    });

    it('detects a Ukrainian message (distinctive і/ї/є/ґ) and shows a Cyrillic (uk) word', async () => {
      const word = await openingWord({
        vendorChatId: 'chat-1',
        turnId: 'turn-1',
        chatType: ChatType.Private,
        languageCode: 'en',
        messageText: 'перенеси зустріч на завтра', // зустріч → і → uk
      });

      expect(word).toMatch(CYRILLIC);
    });

    it('falls back to the language_code when the message text is inconclusive', async () => {
      // Digits/emoji only → detector returns null → language_code (ru) drives it.
      const word = await openingWord({
        vendorChatId: 'chat-1',
        turnId: 'turn-1',
        chatType: ChatType.Private,
        languageCode: 'ru',
        messageText: '15:30 👍',
      });

      expect(word).toMatch(CYRILLIC); // ru, not en
    });

    it('defaults to en (Latin) when the message is inconclusive AND the language_code is unsupported', async () => {
      const word = await openingWord({
        vendorChatId: 'chat-1',
        turnId: 'turn-1',
        chatType: ChatType.Private,
        languageCode: 'fr',
        messageText: '123',
      });

      expect(word).not.toMatch(CYRILLIC); // en (Latin)
    });

    it('voice pre-STT uses the language_code for the Listening line (no text yet)', async () => {
      // Pre-STT open: only language_code is known (no message text, no STT lang).
      const animation = await service.begin({
        vendorChatId: 'chat-1',
        turnId: 'turn-1',
        chatType: ChatType.Private,
        languageCode: 'uk',
      });

      await animation.showVoiceListening();

      const line = vendor.editMessageText.mock.calls.at(-1)?.[1].text;

      // The pre-STT line is the Ukrainian voice line (from language_code), wrapped
      // in a <pre> code block (R1 / ADR 0057).
      expect(line).toBe('<pre>Слухаю ваш чудовий голос</pre>');

      await animation.finalize();
    });

    it('voice pre-STT borrows the prior-turn locale for the Listening line when language_code is unsupported (R2 / ADR 0055)', async () => {
      // No STT lang, no text, an UNSUPPORTED language_code (fr) — the borrowed
      // priorLocale (ru) is the only signal, so a follow-up voice note keeps the
      // conversation's language instead of snapping to the English voice line.
      const animation = await service.begin({
        vendorChatId: 'chat-1',
        turnId: 'turn-1',
        chatType: ChatType.Private,
        languageCode: 'fr',
        priorLocale: 'ru',
      });

      await animation.showVoiceListening();

      const line = vendor.editMessageText.mock.calls.at(-1)?.[1].text;

      expect(line).toBe('<pre>Слушаю ваш прекрасный голос</pre>');

      await animation.finalize();
    });

    it('voice post-STT drives the loading word from the STT-reported spoken language (over an English code)', async () => {
      // Post-STT re-open of the SAME idempotent surface: the STT language ('ru')
      // wins over an English language_code, so the loading word is Cyrillic.
      const word = await openingWord({
        vendorChatId: 'chat-1',
        turnId: 'turn-1',
        chatType: ChatType.Private,
        languageCode: 'en',
        sttLanguage: 'ru',
        messageText: 'move my meeting', // transcript; STT lang still wins
      });

      expect(word).toMatch(CYRILLIC); // ru
    });
  });

  describe('streamAnswer (R3 / ADR 0058 token streaming)', () => {
    it('STOPS the spinner on the first token so no late frame reverts the streamed text', async () => {
      jest.useFakeTimers();
      jest.setSystemTime(0);

      try {
        const { service, vendor } = buildAnimator();

        const animation = await service.begin({
          vendorChatId: 'chat-1',
          turnId: 'turn-1',
          chatType: ChatType.Private,
          languageCode: 'en',
        });

        await animation.startLoading();
        await jest.advanceTimersByTimeAsync(SPINNER_INTERVAL_MS * 2);

        // First token: the spinner must die.
        animation.streamAnswer('Hello');
        await jest.advanceTimersByTimeAsync(0);

        const editsAfterFirstToken = vendor.editMessageText.mock.calls.length;

        // Advancing the clock queues NO further spinner frame (it is stopped).
        await jest.advanceTimersByTimeAsync(SPINNER_INTERVAL_MS * 5);

        // Only streamAnswer's own (throttled) flush could have edited — assert the
        // spinner contributed nothing more: the streamed text is the last thing
        // shown and it is the bare escaped answer (NOT a <pre> spinner frame).
        const lastText = vendor.editMessageText.mock.calls.at(-1)?.[1].text;

        expect(lastText).toBe('Hello');
        // No NEW spinner frames after the token (count unchanged sans our flush).
        expect(vendor.editMessageText.mock.calls.length).toBe(
          editsAfterFirstToken,
        );

        await animation.finalize();
      } finally {
        jest.clearAllTimers();
        jest.useRealTimers();
      }
    });

    it('streams the answer as bare HTML-escaped PLAIN text (no <pre> wrapper) with OutboundFormat.Html', async () => {
      jest.useFakeTimers();
      jest.setSystemTime(0);

      try {
        const { service, vendor } = buildAnimator();

        const animation = await service.begin({
          vendorChatId: 'chat-1',
          turnId: 'turn-1',
          chatType: ChatType.Private,
          languageCode: 'en',
        });

        animation.streamAnswer('a < b & c');
        await jest.advanceTimersByTimeAsync(0);

        expect(vendor.editMessageText).toHaveBeenLastCalledWith(
          expect.objectContaining({ vendorChatId: 'chat-1' }),
          expect.objectContaining({
            vendorMessageId: 'status-msg-1',
            text: 'a &lt; b &amp; c',
            format: OutboundFormat.Html,
          }),
        );

        await animation.finalize();
      } finally {
        jest.clearAllTimers();
        jest.useRealTimers();
      }
    });

    it('THROTTLES to ~1/sec: rapid snapshots coalesce into far fewer edits', async () => {
      jest.useFakeTimers();
      jest.setSystemTime(0);

      try {
        const { service, vendor } = buildAnimator();

        const animation = await service.begin({
          vendorChatId: 'chat-1',
          turnId: 'turn-1',
          chatType: ChatType.Private,
          languageCode: 'en',
        });

        const editsBefore = vendor.editMessageText.mock.calls.length;

        // 20 snapshots within the SAME throttle window (no clock advance between):
        // the first flushes immediately, the rest coalesce away.
        for (let index = 1; index <= 20; index += 1) {
          animation.streamAnswer('word '.repeat(index).trim());
        }

        await jest.advanceTimersByTimeAsync(0);

        const streamedEdits =
          vendor.editMessageText.mock.calls.length - editsBefore;

        // Far fewer than 20 — coalesced to a single in-window edit.
        expect(streamedEdits).toBe(1);

        await animation.finalize();
      } finally {
        jest.clearAllTimers();
        jest.useRealTimers();
      }
    });

    it('pushes a new edit once the throttle window elapses (>= ~1s apart)', async () => {
      jest.useFakeTimers();
      jest.setSystemTime(0);

      try {
        const { service, vendor } = buildAnimator();

        const animation = await service.begin({
          vendorChatId: 'chat-1',
          turnId: 'turn-1',
          chatType: ChatType.Private,
          languageCode: 'en',
        });

        const editsBefore = vendor.editMessageText.mock.calls.length;

        animation.streamAnswer('frame 1');
        await jest.advanceTimersByTimeAsync(SPINNER_INTERVAL_MS + 50);
        animation.streamAnswer('frame 1 and 2');
        await jest.advanceTimersByTimeAsync(0);

        const streamedEdits =
          vendor.editMessageText.mock.calls.length - editsBefore;

        // Two windows ⇒ two edits.
        expect(streamedEdits).toBe(2);
        expect(vendor.editMessageText.mock.calls.at(-1)?.[1].text).toBe(
          'frame 1 and 2',
        );

        await animation.finalize();
      } finally {
        jest.clearAllTimers();
        jest.useRealTimers();
      }
    });

    it('settle FLUSHES the latest coalesced snapshot before draining (so it reaches the chain)', async () => {
      jest.useFakeTimers();
      jest.setSystemTime(0);

      try {
        const { service, vendor } = buildAnimator();

        const animation = await service.begin({
          vendorChatId: 'chat-1',
          turnId: 'turn-1',
          chatType: ChatType.Private,
          languageCode: 'en',
        });

        // First token flushes 'a'; the next two are throttled away (same window).
        animation.streamAnswer('a');
        animation.streamAnswer('a b');
        animation.streamAnswer('a b c');

        // settle must push the latest held snapshot ('a b c') onto the chain.
        await animation.settle();

        expect(vendor.editMessageText.mock.calls.at(-1)?.[1].text).toBe(
          'a b c',
        );

        await animation.finalize();
      } finally {
        jest.clearAllTimers();
        jest.useRealTimers();
      }
    });

    it('is a no-op for empty text and once finalized', async () => {
      const { service, vendor } = buildAnimator();

      const animation = await service.begin({
        vendorChatId: 'chat-1',
        turnId: 'turn-1',
        chatType: ChatType.Private,
        languageCode: 'en',
      });

      animation.streamAnswer('');
      expect(vendor.editMessageText).not.toHaveBeenCalled();

      await animation.finalize();
      animation.streamAnswer('too late');
      await animation.settle();

      // Nothing streamed: empty was ignored and the post-finalize token no-ops.
      expect(vendor.editMessageText).not.toHaveBeenCalled();
    });
  });
});
