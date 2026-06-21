import { Inject, Injectable, Logger } from '@nestjs/common';

import { detectMessageLanguage } from './detect-message-language';
import { DraftThrottle } from './draft-throttle';
import {
  nextLoadingWord,
  resolveVoiceStatusLocale,
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
  OutboundFormat,
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
 * Escapes the only three characters Telegram HTML requires escaping (`< > &`),
 * mirroring the chunk-1 converter's `escapeHtml` (ADR 0049). Ampersand first so
 * it never double-escapes the entities it produces. Used to make a recap safe to
 * nest inside a `<blockquote>` in the composite draft body.
 */
const escapeTelegramHtml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The composed parts of the ONE live-status draft (v2 Task 5, ADR 0050). The
 * status line (cycling word + animated dots) always sits on TOP; the optional
 * detail block (the model's between-rounds recap) renders BELOW it as a quote.
 * Both share one draft body via {@link StatusAnimation.renderComposite} so they
 * compose instead of clobbering each other (the pre-Task-5 last-writer-wins bug).
 */
interface CompositeViewModel {
  /** The status line on top: the loading word + the animated trailing dots. */
  statusLine: string;
  /** The optional recap rendered below the status line as an HTML blockquote. */
  detailBlock?: string;
}

/**
 * Inputs to open a live-status animation for one turn. `turnId` keys the Redis
 * StatusSession (idempotent) AND derives the draft id, so the voice notice and
 * the loading loop for the same turn share one surface.
 *
 * The loading-status locale is resolved here from these three fields, in priority
 * order (v2 Task 4 / ADR 0051) — MESSAGE language first, `language_code` as the
 * fallback:
 * - `sttLanguage`: the STT-reported spoken language (voice turns AFTER STT). Wins
 *   when it maps to a supported locale, so the loading words switch to the spoken
 *   language.
 * - `messageText`: the message's OWN text (a typed message, or a voice transcript
 *   post-STT). Its detected language is used when conclusive — this is what makes a
 *   Russian message show Russian loading words under an English `language_code`.
 * - `languageCode`: the raw Telegram `language_code` — the FALLBACK (and the SOLE
 *   signal for the pre-STT "Listening…" line, where no text exists yet).
 *
 * Anything unsupported collapses to `en`. The pre-STT voice open passes only
 * `languageCode`; the text-turn open passes `messageText` (+ `languageCode`); the
 * post-STT re-open passes `sttLanguage` + the transcript as `messageText`.
 */
export interface StatusAnimationInput {
  vendorChatId: string;
  turnId: string;
  chatType?: ChatType;
  languageCode?: string;
  /** The message's own text (typed message or voice transcript) — detected for the locale. */
  messageText?: string;
  /** STT-reported spoken language (voice post-STT); highest-priority locale signal. */
  sttLanguage?: string;
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

  // The ONE live-status draft's composed parts (v2 Task 5 / ADR 0050): the
  // top status line plus the optional recap detail below. Loading ticks update
  // ONLY statusLine; showRecap updates ONLY detailBlock; both re-render the
  // composite, so they never overwrite each other.
  private composite: CompositeViewModel = { statusLine: '' };

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
   * initial surface. Safe to call more than once for a turn — the StatusSession
   * `open` is idempotent and a second open simply re-reads the existing handle.
   * Degrades silently on any Redis/vendor fault.
   *
   * FIX 3 (scroll mitigation, ADR 0049): on a private (draft) chat this NO LONGER
   * posts an empty-text "Thinking…" placeholder draft. That empty streaming-draft
   * surface made the Telegram client reserve space / scroll the chat to the top on
   * send. We instead defer the FIRST draft frame to {@link startLoading}, which
   * renders a real first loading WORD — so the draft surface only appears once it
   * carries content, shrinking the reserved area. (This only mitigates a
   * client-rendered draft-UX issue; it does not fully eliminate it — see the ADR.)
   * The non-private path is unchanged: it sends one real static line so later
   * in-place edits have a message to target.
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
      // FIX 3: do NOT post an empty-text placeholder draft here — the first draft
      // frame is deferred to startLoading (the first real loading word), so the
      // reserved streaming-draft surface that scrolls the chat never appears empty.
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

    // The working phase (status + recap composite) is over: the streamed answer
    // REPLACES the composite outright, so drop the retained parts to ensure no
    // stale recap/status leaks back if a later frame ever re-rendered (Task 5).
    this.composite = { statusLine: '' };

    if (this.session?.phase !== StatusSessionPhase.Streaming) {
      void this.advancePhaseSafe(StatusSessionPhase.Streaming);
    }

    await this.pushDraft(snapshot);
  }

  /**
   * Renders a one-sentence per-round recap into the live-status draft so the user
   * sees what the model is doing between tool rounds (Story 13 / ADR 0041, v2 Task
   * 5 / ADR 0050). On a draft surface it updates ONLY the composite's
   * {@link CompositeViewModel.detailBlock} (the technical "what it's doing right
   * now") and re-renders the composite, so the recap lands BELOW the status line
   * as a quote — it NEVER clobbers the status word, and it does NOT re-arm /
   * restart the loading timers: the dots keep ticking on top (each tick re-renders
   * the composite with the detail preserved) until {@link streamAnswer} replaces
   * the whole composite with the final answer. Routes through the SAME throttle as
   * every other frame; a no-op once finalized or for empty text; on a non-private
   * surface it edits the static line. Best-effort + degrade-never-throw — a missed
   * recap simply leaves the current frame.
   */
  async showRecap(recap: string): Promise<void> {
    if (this.finalized || recap.length === 0) {
      return;
    }

    if (this.isDraftSurface) {
      // Update ONLY the detail block and re-render the composite: the recap sits
      // below the status line and persists there while the dots keep animating on
      // top (the already-armed loading timers re-render the composite each tick).
      this.composite.detailBlock = recap;

      await this.renderComposite();

      return;
    }

    await this.pushStatic(recap);
  }

  /**
   * Ends the animation on EVERY turn-exit path: clears both timers (no interval
   * leak — ADR 0012 invariant), cancels the throttle's pending flush, COLLAPSES
   * the streamed-answer draft preview, then clears the Redis StatusSession.
   * Idempotent + never throws.
   *
   * Why the collapse (FIX 1 / ADR 0049): the loop streams the full answer into
   * the draft, and the turn ALSO sends the same answer as a real
   * {@link ReplyPresenter.sendText} message. The real message lands first (the
   * caller runs `finishTurn` before this `finally`), so if we left the streamed
   * draft standing the user would briefly see the answer TWICE (the live draft +
   * the real message) and a reopened chat would re-animate the orphan draft until
   * its ~30 s TTL. So when a draft surface is active we push ONE final empty-text
   * draft frame to retract the preview the moment the real message exists. It is
   * sent UN-throttled (a direct `sendMessageDraft`, NOT via the throttle, which we
   * just cancelled) so the collapse is not coalesced away. Empty-text drafts are
   * supported (Bot API ≥ 10.0). Degrade-never-throw — a failed collapse is
   * cosmetic and must never disturb the turn.
   */
  async finalize(): Promise<void> {
    this.finalized = true;
    this.clearTimers();
    this.throttle.cancel();

    await this.collapseDraft();

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
   * Pushes ONE final empty-text draft frame to visually retract the streamed
   * answer preview once the real reply has landed (FIX 1). Only runs on a draft
   * surface that actually has a draft id; a non-private (static-line) or
   * never-opened surface has no draft to collapse and is a silent no-op. Sent
   * DIRECTLY (bypassing the just-cancelled throttle) so the retraction is not
   * coalesced away, and wrapped so a vendor fault degrades silently.
   */
  private async collapseDraft(): Promise<void> {
    const draftId = this.session?.draftId;

    if (!this.isDraftSurface || draftId === undefined) {
      return;
    }

    try {
      await this.vendor.sendMessageDraft(this.target, { draftId, text: '' });
    } catch (error) {
      this.logSurfaceFault('collapse draft', error);
    }
  }

  /**
   * Arms the dot-tick + word-swap loading timers for the animated draft surface,
   * driven by {@link startLoading} (the single arm point). Each tick updates ONLY
   * the composite's status line and re-renders the composite, so the dots keep
   * animating on top while any recap detail block below persists (v2 Task 5 / ADR
   * 0050) — {@link showRecap} no longer re-arms, since the timers are never torn
   * down between rounds; only {@link streamAnswer}/{@link finalize} stop them. A
   * no-op once finalized, on a non-private surface (single static line, no loop),
   * or when the timers are already armed (the ONE-setInterval-pair-per-turn
   * invariant, ADR 0012).
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
   * Advances the `<word><dots>` loading frame: updates ONLY the composite's
   * {@link CompositeViewModel.statusLine} (top), then re-renders the composite so
   * the status word ticks while any recap detail block below it stays put (v2 Task
   * 5 / ADR 0050). On a non-private surface there is no composite — it edits the
   * static line directly. A no-op once finalized so a timer callback that races
   * finalize never re-posts a stale frame.
   */
  private async renderLoadingFrame(): Promise<void> {
    if (this.finalized || !this.currentWord) {
      return;
    }

    const text = `${this.currentWord}${'.'.repeat(this.dotCount)}`;

    if (this.isDraftSurface) {
      // Update ONLY the top status line; the detail block (recap) is preserved so
      // each dot/word tick re-renders the SAME composite with the recap intact.
      this.composite.statusLine = text;

      await this.renderComposite();

      return;
    }

    await this.pushStatic(text);
  }

  /**
   * Composes the ONE live-status draft from the current {@link composite} and
   * pushes it through the throttle as HTML (v2 Task 5 / ADR 0050). The status line
   * sits on top; if a recap detail block is present, a blank line then the recap —
   * HTML-escaped and wrapped in a `<blockquote>` — renders below it as the
   * "technical details of what the model is doing right now". The blank line keeps
   * the two visually distinct; the `<blockquote>` (preferred over `<pre>`) reads
   * as prose, which a recap is (a plain present-tense sentence), where `<pre>`
   * would force a monospace code-block look. Sent with `format:
   * {@link OutboundFormat.Html}` so Telegram actually renders the quote (ties to
   * the chunk-1 Markdown→HTML fix); a no-op once finalized or with an empty status
   * line (nothing to show yet).
   */
  private async renderComposite(): Promise<void> {
    const { statusLine, detailBlock } = this.composite;

    // Nothing to show at all (no status word yet AND no recap) ⇒ skip; and a
    // post-finalize tick must never re-post a stale frame.
    if (
      this.finalized ||
      (statusLine.length === 0 && detailBlock === undefined)
    ) {
      return;
    }

    const quote =
      detailBlock === undefined
        ? ''
        : `<blockquote>${escapeTelegramHtml(detailBlock)}</blockquote>`;

    // Status on top; if a recap exists, a blank line then the quote below it. A
    // recap that arrives before the first status word still renders (quote only).
    const body =
      quote.length === 0
        ? statusLine
        : statusLine.length === 0
          ? quote
          : `${statusLine}\n\n${quote}`;

    await this.pushDraft(body, OutboundFormat.Html);
  }

  /**
   * Submits a draft frame through the throttle, forwarding an optional
   * {@link OutboundFormat} to the connector's {@link MessageDraft} (so the
   * composite's `<blockquote>` renders under `parse_mode=HTML` — v2 Task 5 / ADR
   * 0050). The throttle owns the ~2–5/s cap and swallows the individual send's
   * rejection, so a failed frame is non-fatal and the next coalesced frame
   * supersedes it. `format` is omitted for plain frames (e.g. the streamed
   * answer), keeping them plain-text.
   */
  private async pushDraft(
    text: string,
    format?: OutboundFormat,
  ): Promise<void> {
    const draftId = this.session?.draftId;

    if (draftId === undefined) {
      return;
    }

    await this.throttle.submit(async () => {
      await this.vendor.sendMessageDraft(this.target, {
        draftId,
        text,
        format,
      });
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
   * (idempotent) StatusSession and posts the initial surface before returning: a
   * private chat gets NO empty placeholder draft (FIX 3 / ADR 0049 — the first
   * draft frame is deferred to {@link StatusAnimation.startLoading}'s first real
   * loading word to avoid the empty-draft scroll); a non-private chat still gets a
   * single static line. The caller drives voice/loading and MUST
   * {@link StatusAnimation.finalize} in a `finally`.
   */
  async begin(input: StatusAnimationInput): Promise<StatusAnimation> {
    const animation = new StatusAnimation(
      this.vendor,
      this.statusSessions,
      this.config,
      input,
      this.resolveLocale(input),
    );

    await animation.open();

    return animation;
  }

  /**
   * Resolves the loading-status {@link StatusLocale} for a turn from the input's
   * locale signals (v2 Task 4 / ADR 0051) via the single
   * {@link resolveVoiceStatusLocale} chain: STT language → message-text detection →
   * `language_code` → `en`. The one chain covers all three open shapes — a text
   * turn (`sttLanguage` absent ⇒ detect text → code → en), a voice PRE-STT open
   * (both absent ⇒ code → en for the "Listening…" line), and a voice POST-STT
   * re-open (`sttLanguage` + transcript ⇒ spoken language wins). The detector is the
   * vendored {@link detectMessageLanguage}, restricted to the three supported locales.
   */
  private resolveLocale(input: StatusAnimationInput): StatusLocale {
    return resolveVoiceStatusLocale(
      input.sttLanguage,
      input.messageText,
      input.languageCode,
      detectMessageLanguage,
    );
  }
}
