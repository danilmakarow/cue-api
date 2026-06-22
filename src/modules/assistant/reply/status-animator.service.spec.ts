import { StatusAnimatorService } from './status-animator.service';
import { StatusSessionPhase, StatusSurfaceKind } from './status-session.store';
import {
  ChatAction,
  ChatType,
} from '@/modules/external-vendor/external-vendor.types';

/**
 * Builds a StatusSessionStore fake whose `open` returns a session whose surface
 * kind follows the input chat type (private ⇒ draft, else ⇒ message). `open` is
 * idempotent in spirit here (returns the same seed); `clear`/`advancePhase` are
 * spies. A `failOpen` flag makes `open` reject to exercise the degrade path.
 */
const buildSessionStore = (options: { failOpen?: boolean } = {}) => {
  const clear = jest.fn().mockResolvedValue(undefined);
  const advancePhase = jest.fn().mockResolvedValue(undefined);
  const open = jest.fn(async (input) => {
    if (options.failOpen) {
      throw new Error('redis down');
    }

    const isPrivate = input.chatType === ChatType.Private;

    return {
      vendorChatId: input.vendorChatId,
      turnId: input.turnId,
      chatType: input.chatType,
      surfaceKind: isPrivate
        ? StatusSurfaceKind.Draft
        : StatusSurfaceKind.Message,
      draftId: isPrivate ? input.seedDraftId : undefined,
      vendorMessageId: isPrivate ? undefined : input.seedVendorMessageId,
      locale: input.locale,
      phase: StatusSessionPhase.Thinking,
    };
  });

  return { open, clear, advancePhase };
};

/** Builds a vendor connector fake covering the send / draft / edit / chat-action surface. */
const buildVendor = () => ({
  sendMessage: jest.fn().mockResolvedValue({ vendorMessageId: 'static-msg-1' }),
  sendMessageDraft: jest.fn().mockResolvedValue(undefined),
  editMessageText: jest.fn().mockResolvedValue(undefined),
  sendChatAction: jest.fn().mockResolvedValue(undefined),
});

const CONFIG = {
  statusDotIntervalMs: 500,
  statusWordIntervalMs: 5000,
};

const buildAnimator = (options: { failOpen?: boolean } = {}) => {
  const vendor = buildVendor();
  const sessions = buildSessionStore({ failOpen: options.failOpen });
  const service = new StatusAnimatorService(
    vendor as never,
    sessions as never,
    CONFIG as never,
  );

  return { service, vendor, sessions };
};

describe('StatusAnimatorService (Story 12 live status, ADR 0012)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('does NOT post an empty-text placeholder draft on open for a private chat (FIX 3 scroll mitigation)', async () => {
    const { service, vendor } = buildAnimator();

    const animation = await service.begin({
      vendorChatId: 'chat-1',
      turnId: 'turn-1',
      chatType: ChatType.Private,
      languageCode: 'en',
    });

    // open() no longer seeds an empty "Thinking…" draft — the empty streaming
    // -draft surface is what scrolled the chat. No draft is emitted yet.
    expect(vendor.sendMessageDraft).not.toHaveBeenCalled();

    await animation.finalize();
  });

  it('defers the first draft frame to startLoading, which carries a real loading word (not empty)', async () => {
    const { service, vendor } = buildAnimator();

    const animation = await service.begin({
      vendorChatId: 'chat-1',
      turnId: 'turn-1',
      chatType: ChatType.Private,
      languageCode: 'en',
    });

    // Nothing on open…
    expect(vendor.sendMessageDraft).not.toHaveBeenCalled();

    await animation.startLoading();

    // …then the FIRST draft frame appears, carrying a real <word><dots> — never
    // an empty placeholder.
    expect(vendor.sendMessageDraft).toHaveBeenCalled();

    const firstFrame = vendor.sendMessageDraft.mock.calls[0][1];

    expect(firstFrame.text).not.toBe('');
    expect(firstFrame.text).toMatch(/\.{1,3}$/);
    expect(firstFrame.draftId).toBeGreaterThan(0); // non-zero draft id (Telegram rule)

    await animation.finalize();
  });

  it('animates the trailing dots through the draft surface and clears the interval on finalize', async () => {
    const { service, vendor } = buildAnimator();

    const animation = await service.begin({
      vendorChatId: 'chat-1',
      turnId: 'turn-1',
      chatType: ChatType.Private,
      languageCode: 'en',
    });

    await animation.startLoading();

    // Drive a few dot ticks; flush the throttle's trailing-coalesced frame after
    // each so the latest <word><dots> frame actually reaches the draft surface.
    await jest.advanceTimersByTimeAsync(CONFIG.statusDotIntervalMs);
    await jest.advanceTimersByTimeAsync(CONFIG.statusDotIntervalMs);

    const latestFrame = vendor.sendMessageDraft.mock.calls.at(-1)?.[1].text;

    // The animated frame is a word followed by 1–3 trailing dots.
    expect(latestFrame).toMatch(/\.{1,3}$/);

    // Finalize clears BOTH timers — no further draft sends after teardown.
    await animation.finalize();

    const afterFinalize = vendor.sendMessageDraft.mock.calls.length;

    await jest.advanceTimersByTimeAsync(CONFIG.statusDotIntervalMs * 4);

    expect(vendor.sendMessageDraft.mock.calls.length).toBe(afterFinalize);
  });

  it('swaps the loading word on the word interval without an immediate repeat', async () => {
    const { service, vendor } = buildAnimator();

    const animation = await service.begin({
      vendorChatId: 'chat-1',
      turnId: 'turn-1',
      chatType: ChatType.Private,
      languageCode: 'en',
    });

    await animation.startLoading();

    // Flush the first loading frame, capture its word.
    await jest.advanceTimersByTimeAsync(CONFIG.statusDotIntervalMs);

    const wordOf = (text: string): string => text.replace(/\.+$/, '');
    const firstWord = wordOf(
      vendor.sendMessageDraft.mock.calls.at(-1)?.[1].text ?? '',
    );

    // One full word interval ⇒ the word swaps (and never repeats back-to-back).
    await jest.advanceTimersByTimeAsync(CONFIG.statusWordIntervalMs);

    const secondWord = wordOf(
      vendor.sendMessageDraft.mock.calls.at(-1)?.[1].text ?? '',
    );

    expect(secondWord).not.toBe(firstWord);

    await animation.finalize();
  });

  it('shows the localized voice line then transitions to the loading animation', async () => {
    const { service, vendor } = buildAnimator();

    const animation = await service.begin({
      vendorChatId: 'chat-1',
      turnId: 'turn-1',
      chatType: ChatType.Private,
      languageCode: 'ru',
    });

    await animation.showVoiceListening();

    // Flush the throttle so the coalesced voice frame reaches the surface.
    await jest.advanceTimersByTimeAsync(CONFIG.statusDotIntervalMs);

    const voiceFrame = vendor.sendMessageDraft.mock.calls.at(-1)?.[1].text;

    expect(voiceFrame).toBe('Слушаю ваш прекрасный голос');
    expect(vendor.sendChatAction).toHaveBeenCalledWith(
      expect.objectContaining({ vendorChatId: 'chat-1' }),
      ChatAction.RecordVoice,
    );

    // Transition: the loading loop supersedes the voice line.
    await animation.startLoading();
    await jest.advanceTimersByTimeAsync(CONFIG.statusDotIntervalMs);

    const loadingFrame = vendor.sendMessageDraft.mock.calls.at(-1)?.[1].text;

    expect(loadingFrame).not.toBe('Слушаю ваш прекрасный голос');
    expect(loadingFrame).toMatch(/\.{1,3}$/);

    await animation.finalize();
  });

  describe('loading-word locale resolution (v2 Task 4 / ADR 0051)', () => {
    // The loading word is picked at random from the locale's vocabulary, so a
    // single frame's exact word is not deterministic. We instead assert the word's
    // SCRIPT, which is decisive: the en vocabulary is all-Latin while the ru/uk
    // vocabularies are all-Cyrillic. (ru vs uk both being Cyrillic is covered by
    // the pure status-phrases.spec.ts unit tests on the resolver chain.)
    const CYRILLIC = /[А-яЁёІіЇїЄєҐґ]/;

    /** Strips the trailing animated dots to recover the bare loading word. */
    const wordOf = (text: string): string => text.replace(/\.+$/, '');

    /** Runs a turn's first loading frame and returns the bare loading word. */
    const firstLoadingWord = async (
      input: Parameters<typeof service.begin>[0],
    ): Promise<string> => {
      const animation = await service.begin(input);

      await animation.startLoading();
      await jest.advanceTimersByTimeAsync(CONFIG.statusDotIntervalMs);

      const word = wordOf(
        vendor.sendMessageDraft.mock.calls.at(-1)?.[1].text ?? '',
      );

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

    it('drives the loading words from the MESSAGE text, OVERRIDING an English language_code (the bug fix)', async () => {
      // The user writes Russian but their Telegram language_code is English — the
      // message text must win so the loading words are Cyrillic (ru), not Latin (en).
      const word = await firstLoadingWord({
        vendorChatId: 'chat-1',
        turnId: 'turn-1',
        chatType: ChatType.Private,
        languageCode: 'en',
        messageText: 'перенеси встречу на завтра',
      });

      expect(word).toMatch(CYRILLIC);
    });

    it('detects a Ukrainian message (distinctive і/ї/є/ґ) and shows Cyrillic (uk) words', async () => {
      const word = await firstLoadingWord({
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
      const word = await firstLoadingWord({
        vendorChatId: 'chat-1',
        turnId: 'turn-1',
        chatType: ChatType.Private,
        languageCode: 'ru',
        messageText: '15:30 👍',
      });

      expect(word).toMatch(CYRILLIC); // ru, not en
    });

    it('defaults to en (Latin) when the message is inconclusive AND the language_code is unsupported', async () => {
      const word = await firstLoadingWord({
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
      await jest.advanceTimersByTimeAsync(CONFIG.statusDotIntervalMs);

      const line = vendor.sendMessageDraft.mock.calls.at(-1)?.[1].text;

      // The pre-STT line is the Ukrainian voice line (from language_code).
      expect(line).toBe('Слухаю ваш чудовий голос');

      await animation.finalize();
    });

    it('voice post-STT switches the loading words to the STT-reported spoken language (over an English code)', async () => {
      // Post-STT re-open of the SAME idempotent surface: the STT language ('ru')
      // wins over an English language_code, so the loading words are Cyrillic.
      const word = await firstLoadingWord({
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

  it('sends a single static real line for a non-private chat (no draft, no interval)', async () => {
    const { service, vendor } = buildAnimator();

    const animation = await service.begin({
      vendorChatId: 'chat-grp',
      turnId: 'turn-1',
      chatType: ChatType.Group,
      languageCode: 'en',
    });

    // Non-private surface ⇒ no draft ever, but a single REAL static line lands
    // via sendMessage (no caller seeds a message id — the surface mints its own).
    expect(vendor.sendMessageDraft).not.toHaveBeenCalled();
    expect(vendor.sendMessage).toHaveBeenCalledTimes(1);

    const [staticTarget, staticMessage] = vendor.sendMessage.mock.calls[0];

    expect(staticTarget).toEqual(
      expect.objectContaining({ vendorChatId: 'chat-grp' }),
    );
    // A single localized loading word with exactly one trailing dot (no animation).
    expect(staticMessage.text).toMatch(/^[A-Za-z]+\.$/);

    await animation.startLoading();

    // The static line is the ONLY surface write: no draft, no edits, and no
    // second send — the non-private path never arms the animation loop.
    const sendsAfterStart = vendor.sendMessage.mock.calls.length;
    const editsAfterStart = vendor.editMessageText.mock.calls.length;

    await jest.advanceTimersByTimeAsync(CONFIG.statusDotIntervalMs * 6);

    expect(vendor.sendMessage.mock.calls.length).toBe(sendsAfterStart);
    expect(vendor.editMessageText.mock.calls.length).toBe(editsAfterStart);
    expect(vendor.sendMessageDraft).not.toHaveBeenCalled();

    await animation.finalize();
  });

  it('degrades (never throws) and still allows the turn to proceed when open fails', async () => {
    const { service, vendor, sessions } = buildAnimator({ failOpen: true });

    const animation = await service.begin({
      vendorChatId: 'chat-1',
      turnId: 'turn-1',
      chatType: ChatType.Private,
      languageCode: 'en',
    });

    // No surface was posted (session open failed) but no throw escaped.
    expect(vendor.sendMessageDraft).not.toHaveBeenCalled();

    // startLoading + finalize are likewise safe no-ops.
    await expect(animation.startLoading()).resolves.toBeUndefined();
    await expect(animation.finalize()).resolves.toBeUndefined();
    expect(sessions.clear).toHaveBeenCalledTimes(1);
  });

  it('swallows a draft-send fault so the animation loop keeps running', async () => {
    const { service, vendor } = buildAnimator();

    vendor.sendMessageDraft.mockRejectedValue(new Error('telegram 500'));

    const animation = await service.begin({
      vendorChatId: 'chat-1',
      turnId: 'turn-1',
      chatType: ChatType.Private,
      languageCode: 'en',
    });

    // The failing open-draft did not throw; startLoading + ticks are safe too.
    await expect(animation.startLoading()).resolves.toBeUndefined();
    await expect(
      jest.advanceTimersByTimeAsync(CONFIG.statusDotIntervalMs * 2),
    ).resolves.toBeUndefined();

    await animation.finalize();
  });

  it('clears the StatusSession on finalize (no stale handle)', async () => {
    const { service, sessions } = buildAnimator();

    const animation = await service.begin({
      vendorChatId: 'chat-1',
      turnId: 'turn-1',
      chatType: ChatType.Private,
      languageCode: 'en',
    });

    await animation.finalize();

    expect(sessions.clear).toHaveBeenCalledWith('chat-1', 'turn-1');
  });

  describe('finalize (ADR 0052 — no draft collapse)', () => {
    it('pushes NO extra draft frame on finalize — the real reply supersedes the preview', async () => {
      const { service, vendor, sessions } = buildAnimator();

      const animation = await service.begin({
        vendorChatId: 'chat-1',
        turnId: 'turn-1',
        chatType: ChatType.Private,
        languageCode: 'en',
      });

      // Run the loading animation so the draft surface is live with status frames.
      await animation.startLoading();
      await jest.advanceTimersByTimeAsync(CONFIG.statusDotIntervalMs);

      const beforeFinalize = vendor.sendMessageDraft.mock.calls.length;

      await animation.finalize();
      await jest.advanceTimersByTimeAsync(CONFIG.statusWordIntervalMs * 2);

      // No empty-text "collapse" frame (the old FIX 1 artifact that surfaced as a
      // blank bubble) and no late ticks: finalize only tears down the timers and
      // clears the session. The real `sendMessage` (L9) supersedes the preview.
      expect(vendor.sendMessageDraft.mock.calls.length).toBe(beforeFinalize);
      expect(sessions.clear).toHaveBeenCalledWith('chat-1', 'turn-1');
    });

    it('never touches the draft API for a non-private (static-line) surface', async () => {
      const { service, vendor } = buildAnimator();

      const animation = await service.begin({
        vendorChatId: 'chat-grp',
        turnId: 'turn-1',
        chatType: ChatType.Group,
        languageCode: 'en',
      });

      await animation.finalize();

      expect(vendor.sendMessageDraft).not.toHaveBeenCalled();
    });

    it('degrades (never throws) when clearing the session fails', async () => {
      const { service, sessions } = buildAnimator();

      const animation = await service.begin({
        vendorChatId: 'chat-1',
        turnId: 'turn-1',
        chatType: ChatType.Private,
        languageCode: 'en',
      });

      // The session clear rejects — finalize must still resolve.
      sessions.clear.mockRejectedValue(new Error('redis down'));

      await expect(animation.finalize()).resolves.toBeUndefined();
    });
  });

  describe('recaps (Story 13 / ADR 0041, narrowed by ADR 0052)', () => {
    it('renders a per-round recap BELOW the status line as an HTML blockquote composite (not a replacement) and ignores an empty recap', async () => {
      const { service, vendor } = buildAnimator();

      const animation = await service.begin({
        vendorChatId: 'chat-1',
        turnId: 'turn-1',
        chatType: ChatType.Private,
        languageCode: 'en',
      });

      // The status word must already be on top before a recap arrives (real flow:
      // startLoading runs at turn start, recaps land between tool rounds).
      await animation.startLoading();
      await jest.advanceTimersByTimeAsync(CONFIG.statusDotIntervalMs);

      const statusFrame = vendor.sendMessageDraft.mock.calls.at(-1)?.[1].text;

      // Pre-recap the draft is JUST the animated status line — no quote yet.
      expect(statusFrame).toMatch(/\.{1,3}$/);
      expect(statusFrame).not.toContain('<blockquote>');

      const before = vendor.sendMessageDraft.mock.calls.length;

      await animation.showRecap('');

      // Empty recap is a no-op.
      expect(vendor.sendMessageDraft.mock.calls.length).toBe(before);

      await animation.showRecap('Checking Thursday afternoon');
      await jest.advanceTimersByTimeAsync(CONFIG.statusDotIntervalMs);

      const composite = vendor.sendMessageDraft.mock.calls.at(-1)?.[1];

      // ONE composite draft: the status word still on TOP, the recap BELOW it as
      // an HTML <blockquote> (the recap did NOT replace the status — Task 5).
      expect(composite?.text).toContain(
        '<blockquote>Checking Thursday afternoon</blockquote>',
      );
      // The status line survives above the quote (a <word><dots> frame precedes it).
      expect(composite?.text).toMatch(
        /\.{1,3}\n\n<blockquote>Checking Thursday afternoon<\/blockquote>$/,
      );
      // Sent as HTML so Telegram renders the quote (ties to the ADR 0049 fix).
      expect(composite?.format).toBe('html');

      await animation.finalize();
    });

    it('keeps the status word cycling while the recap persists below (a loading tick after a recap re-renders the SAME composite, detail intact)', async () => {
      const { service, vendor } = buildAnimator();

      const animation = await service.begin({
        vendorChatId: 'chat-1',
        turnId: 'turn-1',
        chatType: ChatType.Private,
        languageCode: 'en',
      });

      await animation.startLoading();
      await jest.advanceTimersByTimeAsync(CONFIG.statusDotIntervalMs);

      // Land the between-rounds recap on the draft (flush the coalesced frame).
      await animation.showRecap('Checking Thursday afternoon');
      await jest.advanceTimersByTimeAsync(CONFIG.statusDotIntervalMs);

      const recapFrame = vendor.sendMessageDraft.mock.calls.at(-1)?.[1].text;

      expect(recapFrame).toContain(
        '<blockquote>Checking Thursday afternoon</blockquote>',
      );

      // The dots keep animating ON TOP: a later word swap re-renders the SAME
      // composite — a new <word><dots> status line, with the recap STILL below it
      // (the recap was not re-armed/cleared; it persists while the dots tick).
      const callsAfterRecap = vendor.sendMessageDraft.mock.calls.length;

      await jest.advanceTimersByTimeAsync(CONFIG.statusWordIntervalMs);

      expect(vendor.sendMessageDraft.mock.calls.length).toBeGreaterThan(
        callsAfterRecap,
      );

      const tickAfterRecap = vendor.sendMessageDraft.mock.calls.at(-1)?.[1];

      // Composite re-rendered: status line on top (animated dots) AND the recap
      // detail STILL below it, sent as HTML.
      expect(tickAfterRecap?.text).toMatch(
        /\.{1,3}\n\n<blockquote>Checking Thursday afternoon<\/blockquote>$/,
      );
      expect(tickAfterRecap?.format).toBe('html');

      // finalize stops the loop — no animation frames after teardown, and (ADR
      // 0052) NO empty-text collapse frame: the last draft frame remains the recap
      // composite, not a blank bubble.
      const beforeFinalize = vendor.sendMessageDraft.mock.calls.length;
      const lastFrameText = vendor.sendMessageDraft.mock.calls.at(-1)?.[1].text;

      await animation.finalize();

      // Finalize emitted no further draft frame (no collapse).
      expect(vendor.sendMessageDraft.mock.calls.length).toBe(beforeFinalize);
      expect(vendor.sendMessageDraft.mock.calls.at(-1)?.[1].text).toBe(
        lastFrameText,
      );
      expect(lastFrameText).not.toBe('');

      await jest.advanceTimersByTimeAsync(CONFIG.statusWordIntervalMs * 2);

      expect(vendor.sendMessageDraft.mock.calls.length).toBe(beforeFinalize);
    });

    it('HTML-escapes the recap text inside the blockquote (degrade-safe; no tag injection)', async () => {
      const { service, vendor } = buildAnimator();

      const animation = await service.begin({
        vendorChatId: 'chat-1',
        turnId: 'turn-1',
        chatType: ChatType.Private,
        languageCode: 'en',
      });

      await animation.startLoading();
      await jest.advanceTimersByTimeAsync(CONFIG.statusDotIntervalMs);

      await animation.showRecap('Checking <b>A & B</b> > now');
      await jest.advanceTimersByTimeAsync(CONFIG.statusDotIntervalMs);

      const composite = vendor.sendMessageDraft.mock.calls.at(-1)?.[1].text;

      // The recap's <, >, & are escaped so it cannot inject a tag Telegram rejects.
      expect(composite).toContain(
        '<blockquote>Checking &lt;b&gt;A &amp; B&lt;/b&gt; &gt; now</blockquote>',
      );

      await animation.finalize();
    });

    it('is a no-op once finalized (a late recap frame never re-posts)', async () => {
      const { service, vendor } = buildAnimator();

      const animation = await service.begin({
        vendorChatId: 'chat-1',
        turnId: 'turn-1',
        chatType: ChatType.Private,
        languageCode: 'en',
      });

      await animation.finalize();

      const afterFinalize = vendor.sendMessageDraft.mock.calls.length;

      await animation.showRecap('also too late');
      await jest.advanceTimersByTimeAsync(1000);

      expect(vendor.sendMessageDraft.mock.calls.length).toBe(afterFinalize);
    });
  });
});
