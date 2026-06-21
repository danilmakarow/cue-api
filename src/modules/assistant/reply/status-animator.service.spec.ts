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

  it('posts an empty-text draft (native "Thinking…") on open for a private chat', async () => {
    const { service, vendor } = buildAnimator();

    const animation = await service.begin({
      vendorChatId: 'chat-1',
      turnId: 'turn-1',
      chatType: ChatType.Private,
      languageCode: 'en',
    });

    expect(vendor.sendMessageDraft).toHaveBeenCalledTimes(1);

    const [, draft] = vendor.sendMessageDraft.mock.calls[0];

    expect(draft.text).toBe('');
    expect(draft.draftId).toBeGreaterThan(0); // non-zero draft id (Telegram rule)

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

  describe('streaming + recaps (Story 13 / ADR 0041)', () => {
    it('streams the answer snapshot into the draft through the throttle and stops the loading loop', async () => {
      const { service, vendor } = buildAnimator();

      const animation = await service.begin({
        vendorChatId: 'chat-1',
        turnId: 'turn-1',
        chatType: ChatType.Private,
        languageCode: 'en',
      });

      await animation.startLoading();

      // The final round begins streaming — the latest snapshot is rendered (flush
      // the throttle's trailing-coalesced frame so it reaches the surface).
      await animation.streamAnswer('Booking the dentist');
      await jest.advanceTimersByTimeAsync(1000);

      const latest = vendor.sendMessageDraft.mock.calls.at(-1)?.[1].text;

      expect(latest).toBe('Booking the dentist');

      // Streaming stopped the loading timers: no cycling-word frame supersedes
      // the streamed snapshot on subsequent ticks.
      const callsAfterStream = vendor.sendMessageDraft.mock.calls.length;

      await jest.advanceTimersByTimeAsync(CONFIG.statusWordIntervalMs * 2);

      expect(vendor.sendMessageDraft.mock.calls.length).toBe(callsAfterStream);

      await animation.finalize();
    });

    it('coalesces rapid stream snapshots through the one throttle (never per-token to the vendor)', async () => {
      const { service, vendor } = buildAnimator();

      const animation = await service.begin({
        vendorChatId: 'chat-1',
        turnId: 'turn-1',
        chatType: ChatType.Private,
        languageCode: 'en',
      });

      const sendsBefore = vendor.sendMessageDraft.mock.calls.length;

      // Fire many snapshots back-to-back (a per-token stream) WITHIN one throttle
      // window, then flush. The throttle coalesces them so the vendor sees at most
      // one send for the whole burst — never one per token.
      await animation.streamAnswer('a');
      await animation.streamAnswer('ab');
      await animation.streamAnswer('abc');
      await animation.streamAnswer('abcd');
      await animation.streamAnswer('abcde');

      // Flush the trailing-coalesced frame.
      await jest.advanceTimersByTimeAsync(1000);

      const burstSends =
        vendor.sendMessageDraft.mock.calls.length - sendsBefore;

      // Far fewer vendor sends than the 5 snapshots — the throttle is the chokepoint.
      expect(burstSends).toBeGreaterThanOrEqual(1);
      expect(burstSends).toBeLessThanOrEqual(2);

      // The LATEST snapshot wins (coalescing keeps only the newest full-text frame).
      expect(vendor.sendMessageDraft.mock.calls.at(-1)?.[1].text).toBe('abcde');

      await animation.finalize();
    });

    it('renders a per-round recap into the draft and ignores an empty recap', async () => {
      const { service, vendor } = buildAnimator();

      const animation = await service.begin({
        vendorChatId: 'chat-1',
        turnId: 'turn-1',
        chatType: ChatType.Private,
        languageCode: 'en',
      });

      const before = vendor.sendMessageDraft.mock.calls.length;

      await animation.showRecap('');

      // Empty recap is a no-op.
      expect(vendor.sendMessageDraft.mock.calls.length).toBe(before);

      await animation.showRecap('Checking Thursday afternoon');
      await jest.advanceTimersByTimeAsync(1000);

      expect(vendor.sendMessageDraft.mock.calls.at(-1)?.[1].text).toBe(
        'Checking Thursday afternoon',
      );

      await animation.finalize();
    });

    it('re-arms the loading loop after a non-final-round recap (draft keeps animating), and finalize stops it', async () => {
      const { service, vendor } = buildAnimator();

      const animation = await service.begin({
        vendorChatId: 'chat-1',
        turnId: 'turn-1',
        chatType: ChatType.Private,
        languageCode: 'en',
      });

      await animation.startLoading();

      // Stop the initial loop so the recap is the sole pending frame, then land
      // the between-rounds recap on the draft (flush the coalesced frame).
      await jest.advanceTimersByTimeAsync(CONFIG.statusWordIntervalMs);

      const textsBeforeRecap = vendor.sendMessageDraft.mock.calls.map(
        (call) => call[1].text,
      );

      await animation.showRecap('Checking Thursday afternoon');
      await jest.advanceTimersByTimeAsync(CONFIG.statusDotIntervalMs);

      const recapLanded = vendor.sendMessageDraft.mock.calls
        .map((call) => call[1].text)
        .slice(textsBeforeRecap.length)
        .includes('Checking Thursday afternoon');

      expect(recapLanded).toBe(true);

      // The loop RESUMES after the recap: a later word swap renders a cycling
      // <word><dots> frame again (the recap did not permanently freeze it).
      const callsAfterRecap = vendor.sendMessageDraft.mock.calls.length;

      await jest.advanceTimersByTimeAsync(CONFIG.statusWordIntervalMs);

      expect(vendor.sendMessageDraft.mock.calls.length).toBeGreaterThan(
        callsAfterRecap,
      );
      expect(vendor.sendMessageDraft.mock.calls.at(-1)?.[1].text).toMatch(
        /\.{1,3}$/,
      );

      // finalize stops the re-armed loop — no further frames after teardown.
      await animation.finalize();

      const afterFinalize = vendor.sendMessageDraft.mock.calls.length;

      await jest.advanceTimersByTimeAsync(CONFIG.statusWordIntervalMs * 2);

      expect(vendor.sendMessageDraft.mock.calls.length).toBe(afterFinalize);
    });

    it('does not stream into a non-private surface (drafts are private-only) and never throws', async () => {
      const { service, vendor } = buildAnimator();

      const animation = await service.begin({
        vendorChatId: 'chat-grp',
        turnId: 'turn-1',
        chatType: ChatType.Group,
        languageCode: 'en',
      });

      await expect(
        animation.streamAnswer('streamed answer'),
      ).resolves.toBeUndefined();

      // No draft on a non-private surface.
      expect(vendor.sendMessageDraft).not.toHaveBeenCalled();

      await animation.finalize();
    });

    it('is a no-op once finalized (a late stream frame never re-posts)', async () => {
      const { service, vendor } = buildAnimator();

      const animation = await service.begin({
        vendorChatId: 'chat-1',
        turnId: 'turn-1',
        chatType: ChatType.Private,
        languageCode: 'en',
      });

      await animation.finalize();

      const afterFinalize = vendor.sendMessageDraft.mock.calls.length;

      await animation.streamAnswer('too late');
      await animation.showRecap('also too late');
      await jest.advanceTimersByTimeAsync(1000);

      expect(vendor.sendMessageDraft.mock.calls.length).toBe(afterFinalize);
    });
  });
});
