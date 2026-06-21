import { Inject, Injectable, Logger } from '@nestjs/common';

import { DraftThrottle } from './draft-throttle';
import {
  nextLoadingWord,
  resolveStatusLocale,
  StatusLocale,
  voiceListeningPhrase,
} from './status-phrases';
import {
  StatusSession,
  StatusSessionPhase,
  StatusSessionStore,
  StatusSurfaceKind,
} from './status-session.store';
import { AssistantConfig } from '../assistant.config';
import { ExternalVendorConnector } from '@/modules/external-vendor/external-vendor-connector.abstract';
import { ACTIVE_VENDOR_CONNECTOR } from '@/modules/external-vendor/external-vendor.module';
import {
  ChatAction,
  ChatType,
  SendTarget,
} from '@/modules/external-vendor/external-vendor.types';

/**
 * A non-zero draft id derived deterministically from a turn id. Telegram requires
 * a **non-zero integer** `draft_id`; we hash the (string) turn id into a stable
 * 31-bit positive int so re-calls within the SAME turn animate the SAME draft,
 * while different turns get different drafts. Deterministic so the consumer's
 * voice notice and the turn-runner's loop (both keyed by the same turn id) target
 * the one draft.
 */
const draftIdFromTurnId = (turnId: string): number => {
  let hash = 0;

  for (let index = 0; index < turnId.length; index += 1) {
    hash = (hash * 31 + turnId.charCodeAt(index)) | 0;
  }

  // Force a non-zero positive 31-bit int (Telegram rejects draft_id === 0).
  return (Math.abs(hash) % 2_147_483_646) + 1;
};

/**
 * Inputs to open a live-status animation for one turn. `turnId` keys the Redis
 * StatusSession (idempotent) AND derives the draft id, so the voice notice and
 * the loading loop for the same turn share one surface. `languageCode` is the
 * raw Telegram `language_code` (resolved to a {@link StatusLocale} here).
 */
export interface StatusAnimationInput {
  vendorChatId: string;
  turnId: string;
  chatType?: ChatType;
  languageCode?: string;
}

/**
 * A live per-turn status animation handle (Story 12, ADR 0012). Owns EXACTLY ONE
 * {@link DraftThrottle} and at most ONE `setInterval`, both for this turn. Every
 * draft/edit write routes through the throttle (the central ~2–5/s cap); every
 * Redis/vendor call is wrapped so a fault DEGRADES the status surface and never
 * throws into the turn (the webhook queue is `attempts:1`).
 *
 * Lifecycle: {@link showVoiceListening} (optional, before STT) → {@link startLoading}
 * (the cycling word + animating dots) → {@link finalize} (clear interval + cancel
 * throttle + clear the StatusSession). {@link finalize} MUST be called in the
 * caller's `finally` on EVERY turn-exit path (success, error, ask_user suspend,
 * held conflict) so no interval leaks.
 */
export class StatusAnimation {
  private readonly logger = new Logger(StatusAnimation.name);

  private readonly throttle: DraftThrottle;

  private readonly target: SendTarget;

  private session: StatusSession | null = null;

  private currentWord: string | undefined;

  private dotCount = 0;

  private tickTimer: ReturnType<typeof setInterval> | null = null;

  private wordTimer: ReturnType<typeof setInterval> | null = null;

  private finalized = false;

  constructor(
    private readonly vendor: ExternalVendorConnector,
    private readonly statusSessions: StatusSessionStore,
    private readonly config: AssistantConfig,
    private readonly input: StatusAnimationInput,
    private readonly locale: StatusLocale,
  ) {
    this.throttle = new DraftThrottle();
    this.target = {
      vendorChatId: input.vendorChatId,
      chatType: input.chatType,
    };
  }

  /**
   * Whether this turn's chat gets the private-draft surface. Non-private chats
   * degrade to a single static edited line (drafts are private-only, ADR 0012).
   */
  private get isDraftSurface(): boolean {
    return this.session?.surfaceKind === StatusSurfaceKind.Draft;
  }

  /**
   * Opens (idempotently) the Redis StatusSession for this turn and posts the
   * initial surface: an EMPTY-TEXT draft (Telegram's native "Thinking…"
   * placeholder) for a private chat, or a single static line otherwise. Safe to
   * call more than once for a turn — the StatusSession `open` is idempotent and a
   * second open simply re-reads the existing handle. Degrades silently on any
   * Redis/vendor fault.
   */
  async open(): Promise<void> {
    try {
      this.session = await this.statusSessions.open({
        vendorChatId: this.input.vendorChatId,
        turnId: this.input.turnId,
        chatType: this.input.chatType ?? ChatType.Private,
        locale: this.locale,
        seedDraftId: draftIdFromTurnId(this.input.turnId),
      });
    } catch (error) {
      this.logSurfaceFault('open status session', error);

      return;
    }

    if (this.isDraftSurface) {
      // Empty-text draft ⇒ native "Thinking…" shimmer (ADR 0012). The dot/word
      // loop supersedes it once startLoading runs.
      await this.pushDraft('');

      return;
    }

    // Non-private: SEND a single real static line and capture its message id, so
    // later in-place edits (voice line / recap) have a message to target. No
    // caller seeds a vendorMessageId; drafts are private-only, so the degraded
    // surface mints its own real message here.
    await this.sendStaticLine(this.staticLoadingLine());
  }

  /**
   * Shows the localized "Listening to your beautiful voice" line while a voice
   * note is transcribed (before classification / normal loading). Also fires a
   * `record_voice` chat action as a presence hint. Routes the surface update
   * through the throttle like every other frame. Degrades silently.
   */
  async showVoiceListening(): Promise<void> {
    void this.fireChatAction();

    const phrase = voiceListeningPhrase(this.locale);

    if (this.isDraftSurface) {
      await this.pushDraft(phrase);

      return;
    }

    await this.pushStatic(phrase);
  }

  /**
   * Starts the loading animation: advances the StatusSession to `Working`, shows
   * the first loading word immediately, then arms two timers — a trailing-dot
   * tick (`.`→`..`→`...`) and a word swap (no immediate repeat). Both re-render
   * through the throttle so the combined draft re-call rate stays under the
   * central cap. A non-draft (non-private) surface keeps its single static line
   * from {@link open} and does NOT render a loading frame or arm the timers (no
   * per-second editing of a real message). Idempotent — a second call is a no-op
   * once timers are armed or the turn is finalized.
   */
  async startLoading(): Promise<void> {
    if (this.finalized || this.tickTimer || this.wordTimer) {
      return;
    }

    void this.advancePhaseSafe(StatusSessionPhase.Working);

    if (!this.isDraftSurface) {
      // Non-private: the single static line already landed in open(); no loop,
      // no further edits.
      return;
    }

    this.currentWord = nextLoadingWord(this.locale, undefined);
    this.dotCount = 1;

    await this.renderLoadingFrame();

    this.armLoadingTimers();
  }

  /**
   * Renders the latest streamed-answer snapshot into the draft (Story 13 / ADR
   * 0041), on the final/answer round. STOPS the cycling-word + dots loading timers
   * first (the streamed text supersedes the loading animation) and advances the
   * session phase to `Streaming`, then pushes the snapshot through the SAME
   * throttle — so per-token deltas coalesce under the central ~2–5/s cap and never
   * hit the draft API in a tight loop. A no-op once finalized, on a non-draft
   * (non-private) surface (no live draft to stream into), or for empty text.
   * Degrades silently — a status fault never disturbs the turn's real reply.
   */
  async streamAnswer(snapshot: string): Promise<void> {
    if (this.finalized || !this.isDraftSurface || snapshot.length === 0) {
      return;
    }

    // The answer is now arriving — tear down the loading loop so the cycling word
    // doesn't race the streamed text on the one shared draft.
    this.clearTimers();

    if (this.session?.phase !== StatusSessionPhase.Streaming) {
      void this.advancePhaseSafe(StatusSessionPhase.Streaming);
    }

    await this.pushDraft(snapshot);
  }

  /**
   * Renders a one-sentence per-round recap into the status draft (Story 13 / ADR
   * 0041) so the user sees progress between tool rounds. Routes through the SAME
   * throttle as every other frame. A no-op once finalized or for empty text; on a
   * non-private surface it edits the static line. Best-effort + degrade-never-throw
   * — a missed recap simply leaves the current frame. A recap is a momentary
   * message BETWEEN tool rounds, so on a draft surface it RE-ARMS the dot/word
   * loading timers afterwards: they keep cycling through the next round (the final
   * streamed answer, via {@link streamAnswer}, is what permanently stops them).
   */
  async showRecap(recap: string): Promise<void> {
    if (this.finalized || recap.length === 0) {
      return;
    }

    if (this.isDraftSurface) {
      await this.pushDraft(recap);
      // The turn moves on to the next round — keep the draft animating so it does
      // not freeze on the recap line until the next recap/stream arrives.
      this.armLoadingTimers();

      return;
    }

    await this.pushStatic(recap);
  }

  /**
   * Ends the animation on EVERY turn-exit path: clears both timers (no interval
   * leak — ADR 0012 invariant), cancels the throttle's pending flush, and clears
   * the Redis StatusSession. Idempotent + never throws — the real reply
   * (`ReplyPresenter.sendText`) supersedes the ephemeral draft, so there is no
   * draft to delete here; we only tear down our own timers + handle.
   */
  async finalize(): Promise<void> {
    this.finalized = true;
    this.clearTimers();
    this.throttle.cancel();

    try {
      await this.statusSessions.clear(
        this.input.vendorChatId,
        this.input.turnId,
      );
    } catch (error) {
      this.logSurfaceFault('clear status session', error);
    }
  }

  /**
   * Arms the dot-tick + word-swap loading timers for the animated draft surface.
   * Shared by {@link startLoading} (initial arm) and {@link showRecap} (re-arm
   * between tool rounds so the draft never freezes on a recap line). A no-op once
   * finalized, on a non-private surface (single static line, no loop), or when the
   * timers are already armed — so a re-arm after a recap never spawns a second
   * interval (the ONE-setInterval-pair-per-turn invariant, ADR 0012).
   */
  private armLoadingTimers(): void {
    if (
      this.finalized ||
      !this.isDraftSurface ||
      this.tickTimer ||
      this.wordTimer
    ) {
      return;
    }

    this.tickTimer = setInterval(() => {
      this.dotCount = (this.dotCount % 3) + 1;
      void this.renderLoadingFrame();
    }, this.config.statusDotIntervalMs);

    this.wordTimer = setInterval(() => {
      this.currentWord = nextLoadingWord(this.locale, this.currentWord);
      this.dotCount = 1;
      void this.renderLoadingFrame();
    }, this.config.statusWordIntervalMs);
  }

  /**
   * Clears both animation timers if armed. Internal helper shared by
   * {@link finalize} so a torn-down animation leaves no handle behind.
   */
  private clearTimers(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }

    if (this.wordTimer) {
      clearInterval(this.wordTimer);
      this.wordTimer = null;
    }
  }

  /**
   * Renders the current `<word><dots>` loading frame to the surface (draft for
   * private, static edit otherwise). A no-op once finalized so a timer callback
   * that races finalize never re-posts a stale frame.
   */
  private async renderLoadingFrame(): Promise<void> {
    if (this.finalized || !this.currentWord) {
      return;
    }

    const text = `${this.currentWord}${'.'.repeat(this.dotCount)}`;

    if (this.isDraftSurface) {
      await this.pushDraft(text);

      return;
    }

    await this.pushStatic(text);
  }

  /**
   * Submits a draft frame through the throttle. The throttle owns the ~2–5/s cap
   * and swallows the individual send's rejection, so a failed frame is non-fatal
   * and the next coalesced frame supersedes it.
   */
  private async pushDraft(text: string): Promise<void> {
    const draftId = this.session?.draftId;

    if (draftId === undefined) {
      return;
    }

    await this.throttle.submit(async () => {
      await this.vendor.sendMessageDraft(this.target, { draftId, text });
    });
  }

  /**
   * Sends the FIRST real status message for the non-private degraded surface and
   * captures its vendor message id into the session, so subsequent in-place edits
   * ({@link pushStatic}) have a message to target. Routes through the throttle
   * like every other frame and degrades never-throw — a send fault leaves the
   * surface without a static line, but the turn still answers. A no-op once
   * finalized or if a message id was already captured (idempotent re-open).
   */
  private async sendStaticLine(text: string): Promise<void> {
    if (this.finalized || !this.session || this.session.vendorMessageId) {
      return;
    }

    await this.throttle.submit(async () => {
      const ref = await this.vendor.sendMessage(this.target, { text });

      if (this.session) {
        this.session.vendorMessageId = ref.vendorMessageId;
      }
    });
  }

  /**
   * Submits a static (non-private) surface update through the throttle: edits the
   * already-posted real status message in place. Shares the throttle so the
   * degraded path inherits the same cap; a missing message id (the first line
   * never landed) is a silent no-op.
   */
  private async pushStatic(text: string): Promise<void> {
    const vendorMessageId = this.session?.vendorMessageId;

    if (!vendorMessageId) {
      // No real message id was seeded for the degraded surface — we cannot edit a
      // message we never created. Degrade silently (the turn still answers).
      return;
    }

    await this.throttle.submit(async () => {
      await this.vendor.editMessageText(this.target, {
        vendorMessageId,
        text,
      });
    });
  }

  /**
   * Fires the `record_voice` presence hint, swallowing any fault (it is a cosmetic
   * extra on top of the voice line).
   */
  private async fireChatAction(): Promise<void> {
    try {
      await this.vendor.sendChatAction(this.target, ChatAction.RecordVoice);
    } catch (error) {
      this.logSurfaceFault('send chat action', error);
    }
  }

  /**
   * Advances the StatusSession phase, swallowing a Redis fault (the phase label is
   * advisory for Story 13's streaming; a missed advance never breaks the turn).
   */
  private async advancePhaseSafe(phase: StatusSessionPhase): Promise<void> {
    try {
      await this.statusSessions.advancePhase(
        this.input.vendorChatId,
        this.input.turnId,
        phase,
      );
    } catch (error) {
      this.logSurfaceFault('advance status phase', error);
    }
  }

  /**
   * The single static loading line for a non-private chat: the first locale word
   * with one trailing dot (no animation, since drafts are private-only).
   */
  private staticLoadingLine(): string {
    return `${nextLoadingWord(this.locale, undefined)}.`;
  }

  /**
   * Logs a degraded status-surface fault at debug level — the status surface is
   * best-effort, so a fault is informational, never an error that should alarm.
   */
  private logSurfaceFault(action: string, error: unknown): void {
    const message = error instanceof Error ? error.message : 'unknown error';

    this.logger.debug(
      `Status surface degraded (${action}) for turn ${this.input.turnId}: ${message}`,
    );
  }
}

/**
 * L9 live-status animator (Story 12, ADR 0012). Factory for per-turn
 * {@link StatusAnimation} handles — the only assistant-side caller of the draft /
 * edit / chat-action surface for status (the real reply still goes through
 * {@link ReplyPresenter}). It resolves the locale from the inbound
 * `language_code`, injects the (sole) vendor connector + StatusSessionStore +
 * config, and hands back a handle the turn lifecycle drives. Every produced
 * handle is degrade-never-throw: a Redis/draft fault skips the surface and the
 * turn still answers.
 */
@Injectable()
export class StatusAnimatorService {
  constructor(
    @Inject(ACTIVE_VENDOR_CONNECTOR)
    private readonly vendor: ExternalVendorConnector,
    private readonly statusSessions: StatusSessionStore,
    private readonly config: AssistantConfig,
  ) {}

  /**
   * Begins a live-status animation for a turn and returns its handle. Opens the
   * (idempotent) StatusSession and posts the initial surface (empty-text draft ⇒
   * native "Thinking…" for a private chat; a single static line otherwise) before
   * returning, so the placeholder appears within ~1 s. The caller drives
   * voice/loading and MUST {@link StatusAnimation.finalize} in a `finally`.
   */
  async begin(input: StatusAnimationInput): Promise<StatusAnimation> {
    const animation = new StatusAnimation(
      this.vendor,
      this.statusSessions,
      this.config,
      input,
      resolveStatusLocale(input.languageCode),
    );

    await animation.open();

    return animation;
  }
}
