import { Inject, Injectable, Logger } from '@nestjs/common';

import { detectMessageLanguage } from './detect-message-language';
import { escapeHtml } from './markdown-to-telegram-html';
import {
  nextLoadingWord,
  resolveVoiceStatusLocale,
  spinnerLoadingLine,
  StatusLocale,
  voiceListeningPhrase,
} from './status-phrases';
import {
  StatusSession,
  StatusSessionPhase,
  StatusSessionStore,
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
 * Minimum gap (ms) between two STREAMED answer edits (R3 / ADR 0058). Token
 * snapshots arrive far faster than Telegram's edit flood-control tolerates, so we
 * coalesce them and push at most one edit per this window (~1/sec), always
 * flushing the latest pending snapshot at {@link StatusAnimation.settle}. Reverses
 * ADR 0053's calm-single-edit intent for the answer surface while keeping the
 * one-message / no-draft guarantee.
 */
const STREAM_EDIT_MIN_INTERVAL_MS = 1000;

/**
 * Inputs to open a live-status surface for one turn. `turnId` keys the Redis
 * StatusSession (idempotent), so a voice notice and the loading line for the same
 * turn share one surface.
 *
 * The loading-status locale is resolved from these fields, in priority order (v2
 * Task 4 / ADR 0051; R2 / ADR 0055) — MESSAGE language first, `language_code`
 * next, then the borrowed prior-turn language:
 * - `sttLanguage`: the STT-reported spoken language (voice turns AFTER STT).
 * - `messageText`: the message's OWN text (typed message, or post-STT transcript).
 * - `languageCode`: the raw Telegram `language_code` — the next fallback (and the
 *   primary signal for the pre-STT "Listening…" line, where no text exists yet).
 * - `priorLocale`: the language the user wrote in on a PRIOR turn (R2 / ADR 0055),
 *   borrowed when nothing above resolves — the only signal a voice PRE-STT line
 *   has when the `language_code` is unsupported/absent, so a follow-up voice note
 *   keeps the conversation's language instead of snapping to `en`.
 *
 * Anything unsupported collapses to `en`.
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
  /**
   * The prior turn's resolved locale (R2 / ADR 0055), borrowed as the last fallback
   * before `en` — chiefly for the voice pre-STT "Listening…" line, which has no
   * text to detect yet. Undefined when nothing is tracked for the user.
   */
  priorLocale?: StatusLocale;
}

/**
 * A live per-turn status handle (ADR 0053, superseding the draft approach of ADRs
 * 0012/0041/0050/0052). Owns the ONE real message for the turn: posts a loading
 * line on {@link open}, edits it with per-round recaps via {@link showRecap}, and
 * exposes its id ({@link messageId}) so the turn's final reply can edit — "morph"
 * — the SAME message into the answer. The user therefore only ever sees ONE
 * message that changes in place: no ephemeral draft (which could not be deleted
 * and lingered as a ~30 s ghost).
 *
 * R1 / ADR 0057 re-introduces a SINGLE, well-behaved animation: an ASCII braille
 * spinner that ticks the captured loading word in place (the loading line AND
 * recaps are rendered as an HTML `<pre>` code block). Unlike the old dot/word
 * animation it does NOT fight Telegram's own indicator — it edits the real
 * message at a ~1 s cadence (never sub-second, to dodge 429 flood-control) and is
 * STOPPED before the reply morphs the answer.
 *
 * Lifecycle: {@link open} → {@link showVoiceListening} (optional, pre-STT) →
 * {@link startLoading} (arms the spinner) → {@link showRecap} (between rounds;
 * stops the spinner) → the reply morphs the message (in the turn runner via the
 * presenter) → {@link finalize} (stops the spinner + clears the Redis session) in
 * the caller's `finally`. The spinner is ALSO stopped at the top of
 * {@link settle} so it is dead before the morph edits the answer. Every
 * vendor/Redis call is wrapped so a fault DEGRADES the status surface and never
 * throws into the turn (the webhook queue is `attempts:1`); if the status message
 * never lands the turn still answers by sending a fresh reply message instead of
 * morphing.
 */
export class StatusAnimation {
  private readonly logger = new Logger(StatusAnimation.name);

  private readonly target: SendTarget;

  private session: StatusSession | null = null;

  private finalized = false;

  // Serializes status edits (recap / voice line / spinner frame) so they apply in
  // dispatch order AND can be drained via {@link settle} before the reply morphs
  // the same message — closing the race where a late in-flight edit lands after,
  // and reverts, the final answer (ADR 0053).
  private pendingEdit: Promise<void> = Promise.resolve();

  // The ASCII spinner (R1 / ADR 0057). `spinnerTimer` is a `setInterval` handle
  // (unref'd so it never holds the process open), `spinnerFrame` the monotonically
  // growing tick counter, and `currentWord` the ONE loading word captured at
  // arm time so each tick animates the same word rather than re-picking.
  private spinnerTimer: NodeJS.Timeout | null = null;

  private spinnerFrame = 0;

  private currentWord: string | null = null;

  // Answer token streaming (R3 / ADR 0058). `lastStreamEditAt` is the
  // `Date.now()` of the last streamed edit actually pushed, used to THROTTLE
  // edits to <= ~1/sec (dodging Telegram edit flood-control); `pendingStreamText`
  // holds the latest coalesced snapshot not yet pushed (a throttled-away frame),
  // flushed by the next un-throttled call AND by {@link settle} so the latest
  // streamed text always reaches the chain before the reply morph. `streaming`
  // flips true on the first token so the spinner is stopped exactly once.
  private lastStreamEditAt = 0;

  private pendingStreamText: string | null = null;

  private streaming = false;

  constructor(
    private readonly vendor: ExternalVendorConnector,
    private readonly statusSessions: StatusSessionStore,
    private readonly input: StatusAnimationInput,
    private readonly locale: StatusLocale,
    private readonly spinnerIntervalMs: number,
  ) {
    this.target = { vendorChatId: input.vendorChatId };
  }

  /**
   * The real message id of this turn's status message, or null when none was
   * posted (the initial send failed). The reply path reads this to edit (morph)
   * the same message into the answer; a null means it sends a fresh message.
   */
  get messageId(): string | null {
    return this.session?.vendorMessageId ?? null;
  }

  /**
   * Drains any in-flight status edit (the serialized recap / voice-line edits) so
   * the caller can MORPH the same message into the final reply without a late
   * recap edit landing after — and reverting — the answer (ADR 0053). The turn
   * runner awaits this after the loop, before the reply. Never throws: the edit
   * chain swallows its own faults.
   */
  async settle(): Promise<void> {
    // Stop the spinner FIRST so no further frame is queued onto the chain while
    // we drain it — the spinner MUST be dead before the reply morphs the answer
    // (R1 / ADR 0057), otherwise a late frame would revert it.
    this.stopSpinner();

    // Flush the latest coalesced streamed snapshot (R3 / ADR 0058) so the most
    // recent answer text reaches the chain before the reply morph supersedes it;
    // a throttled-away frame would otherwise be dropped silently.
    this.flushStream();

    await this.pendingEdit;
  }

  /**
   * Opens the (idempotent) Redis StatusSession and posts the ONE real status
   * message — the first loading line — capturing its id so later recap edits and
   * the final reply morph target it. An idempotent re-open (lost NX race / replay)
   * that already carries a message id reuses it rather than posting a second.
   * Degrades silently on any fault.
   */
  async open(): Promise<void> {
    try {
      this.session = await this.statusSessions.open({
        vendorChatId: this.input.vendorChatId,
        turnId: this.input.turnId,
        chatType: this.input.chatType ?? ChatType.Private,
        locale: this.locale,
      });
    } catch (error) {
      this.logSurfaceFault('open status session', error);

      return;
    }

    if (this.session.vendorMessageId) {
      return;
    }

    await this.postInitialMessage(this.loadingLine());
  }

  /**
   * Shows the localized "listening to your voice" line while a voice note is
   * transcribed, plus a `record_voice` presence hint. Edits the one status
   * message, rendering the line as an HTML `<pre>` code block to match the spinner
   * and recap surface (R1 / ADR 0057). Degrades silently.
   */
  async showVoiceListening(): Promise<void> {
    void this.fireChatAction(ChatAction.RecordVoice);

    await this.editStatus(this.toPreBlock(voiceListeningPhrase(this.locale)));
  }

  /**
   * Advances the StatusSession to `Working`, fires a one-shot `typing` presence
   * hint, then ARMS the ASCII spinner (R1 / ADR 0057): the loading line already
   * landed in {@link open}; the spinner animates that SAME captured word in place
   * until a recap, the settle, or finalize stops it. Idempotent — a no-op once
   * finalized.
   */
  async startLoading(): Promise<void> {
    if (this.finalized) {
      return;
    }

    // Await the (degrade-never-throw) phase advance so the handle settles before
    // the caller drives the loop; the typing hint is a fire-and-forget extra.
    await this.advancePhaseSafe(StatusSessionPhase.Working);
    void this.fireChatAction(ChatAction.Typing);

    this.startSpinner();
  }

  /**
   * Renders a one-sentence per-round recap by editing the one status message (ADR
   * 0053) so the user sees progress between tool rounds. STOPS the spinner first
   * (R1 / ADR 0057) so the recap is not immediately overwritten by the next
   * spinner frame, and renders the (already-localized, R2) recap as an HTML
   * `<pre>` code block. A no-op once finalized or for empty text; best-effort +
   * degrade-never-throw — a missed recap leaves the current line.
   */
  async showRecap(recap: string): Promise<void> {
    this.stopSpinner();

    if (this.finalized || recap.length === 0) {
      return;
    }

    await this.editStatus(this.toPreBlock(recap));
  }

  /**
   * Streams the model's accumulated ANSWER text into the one status message as it
   * is written (R3 / ADR 0058). On the FIRST token it stops R1's spinner (so no
   * late frame reverts the streamed text), then THROTTLES edits to
   * {@link STREAM_EDIT_MIN_INTERVAL_MS} (~1/sec, dodging Telegram edit flood
   * -control) via a `Date.now()` timestamp: an in-window snapshot is COALESCED into
   * {@link pendingStreamText} (latest wins) and flushed by the next un-throttled
   * call or by {@link settle}. The partial answer is rendered as HTML-escaped PLAIN
   * text (NOT a `<pre>` block) — the FINAL formatted answer is delivered separately
   * by the L9 reply morph as the last edit on the same message, so the two
   * reconcile. A no-op once finalized or for empty text.
   */
  streamAnswer(snapshot: string): void {
    if (this.finalized || snapshot.length === 0) {
      return;
    }

    this.pendingStreamText = snapshot;

    // First token: stop the spinner exactly once so it can never revert the
    // streamed text (reuse R1's idempotent stop), and ALWAYS flush this initial
    // snapshot — the user must see the answer begin immediately rather than wait
    // a full throttle window (and `lastStreamEditAt` may legitimately equal
    // `Date.now()` at turn start, which would otherwise throttle the first edge).
    if (!this.streaming) {
      this.streaming = true;
      this.stopSpinner();
      this.lastStreamEditAt = Date.now();
      this.flushStream();

      return;
    }

    const now = Date.now();

    // Throttle: hold the snapshot (coalesced — latest wins) until the window opens.
    if (now - this.lastStreamEditAt < STREAM_EDIT_MIN_INTERVAL_MS) {
      return;
    }

    this.lastStreamEditAt = now;
    this.flushStream();
  }

  /**
   * Ends the status lifecycle: marks finalized and clears the Redis StatusSession.
   * The status MESSAGE is intentionally left untouched — by now the turn's reply
   * has edited (morphed) it into the final answer (ADR 0053), so there is nothing
   * to retract or delete. Idempotent + never throws; MUST be called in the
   * caller's `finally` on every turn-exit path.
   */
  async finalize(): Promise<void> {
    // Stop the spinner FIRST so no queued frame survives finalize and re-posts
    // over the morphed answer (R1 / ADR 0057).
    this.stopSpinner();
    this.finalized = true;

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
   * The initial loading line: CAPTURES the first locale word into
   * {@link currentWord} (so the spinner later animates the SAME word the user
   * already sees) and renders it as the first spinner frame inside an HTML `<pre>`
   * code block (R1 / ADR 0057). The static ellipsis is gone — the rotating spinner
   * frame replaces it.
   */
  private loadingLine(): string {
    this.currentWord = nextLoadingWord(this.locale, undefined);

    return this.toPreBlock(spinnerLoadingLine(this.currentWord, 0));
  }

  /**
   * Posts the ONE real status message (as HTML so the `<pre>` loading line renders
   * as a monospace code block) and captures its id into the session, so recap
   * edits and the reply morph can target it. A no-op once finalized or if a
   * message id is already captured (idempotent re-open). Degrade-never-throw.
   */
  private async postInitialMessage(text: string): Promise<void> {
    if (this.finalized || !this.session || this.session.vendorMessageId) {
      return;
    }

    try {
      const ref = await this.vendor.sendMessage(this.target, {
        text,
        format: OutboundFormat.Html,
      });

      if (this.session) {
        this.session.vendorMessageId = ref.vendorMessageId;
      }
    } catch (error) {
      this.logSurfaceFault('post status message', error);
    }
  }

  /**
   * Wraps status text in an HTML `<pre>` code block (R1 / ADR 0057) after escaping
   * it so the monospace surface renders the spinner / recap / voice line and never
   * injects a tag Telegram rejects. Uses the EXPORTED {@link escapeHtml} so the
   * escape rule is shared with the reply converter.
   */
  private toPreBlock(text: string): string {
    return `<pre>${escapeHtml(text)}</pre>`;
  }

  /**
   * Arms the ASCII spinner (R1 / ADR 0057): a `setInterval` that advances the
   * frame and pushes the captured word's next frame through the (serialized)
   * {@link editStatus} chain. Skipped when no status message landed (a null
   * {@link messageId} — the initial send failed) so it never edits a phantom, and
   * idempotent (a prior timer is cleared first). The timer is `.unref()`'d so it
   * never holds the process open on its own (mirroring the user-lock watchdog).
   */
  private startSpinner(): void {
    this.stopSpinner();

    if (this.messageId === null) {
      return;
    }

    // The captured word from the initial open; fall back to a fresh pick if open
    // degraded before capturing one (e.g. a re-opened surface with no word yet).
    if (this.currentWord === null) {
      this.currentWord = nextLoadingWord(this.locale, undefined);
    }

    this.spinnerTimer = setInterval(() => {
      this.tickSpinner();
    }, this.spinnerIntervalMs);

    this.spinnerTimer.unref?.();
  }

  /**
   * Advances the spinner one frame and pushes the new line through the serialized
   * edit chain (fire-and-forget — the chain swallows its own faults). A no-op once
   * the spinner has been stopped or no word is captured.
   */
  private tickSpinner(): void {
    if (this.spinnerTimer === null || this.currentWord === null) {
      return;
    }

    this.spinnerFrame += 1;
    void this.editStatus(
      this.toPreBlock(spinnerLoadingLine(this.currentWord, this.spinnerFrame)),
    );
  }

  /**
   * Stops the spinner: clears the interval and nulls the handle so {@link settle},
   * {@link finalize}, and {@link showRecap} can guarantee no further frame is
   * queued (R1 / ADR 0057). Idempotent — safe to call when no timer is armed.
   */
  private stopSpinner(): void {
    if (this.spinnerTimer === null) {
      return;
    }

    clearInterval(this.spinnerTimer);
    this.spinnerTimer = null;
  }

  /**
   * Pushes the latest coalesced streamed answer snapshot (R3 / ADR 0058) onto the
   * serialized edit chain, HTML-escaped as PLAIN text (no `<pre>` wrap — the
   * partial answer reads as prose until the final morph reformats it), then clears
   * the pending buffer so it is flushed exactly once. A no-op when nothing is
   * pending. Fire-and-forget — the chain swallows its own fault.
   */
  private flushStream(): void {
    if (this.pendingStreamText === null) {
      return;
    }

    const snapshot = this.pendingStreamText;

    this.pendingStreamText = null;
    void this.editStatus(escapeHtml(snapshot));
  }

  /**
   * Edits the one status message in place, SERIALIZED behind any prior edit via
   * {@link pendingEdit} so frames (spinner / recap / voice line / streamed answer)
   * apply in dispatch order and {@link settle} can drain them before the reply
   * morph. The status surface is always pre-wrapped/escaped HTML, so the edit
   * carries {@link OutboundFormat.Html}. Returns the chain tail so the
   * (fire-and-forget) caller may await it.
   */
  private editStatus(text: string): Promise<void> {
    this.pendingEdit = this.pendingEdit.then(() => this.runStatusEdit(text));

    return this.pendingEdit;
  }

  /**
   * Performs one status edit (as HTML so the `<pre>` code block renders). A no-op
   * once finalized (checked at EXECUTION time, so a queued frame that runs after
   * finalize never re-posts) or when no status message was posted (the initial
   * send failed) — the turn still answers via a fresh reply message. A benign
   * "message is not modified" 400 (an identical repeated spinner frame) is treated
   * as success by the connector. Degrade-never-throw.
   */
  private async runStatusEdit(text: string): Promise<void> {
    const vendorMessageId = this.session?.vendorMessageId;

    if (this.finalized || !vendorMessageId) {
      return;
    }

    try {
      await this.vendor.editMessageText(this.target, {
        vendorMessageId,
        text,
        format: OutboundFormat.Html,
      });
    } catch (error) {
      this.logSurfaceFault('edit status message', error);
    }
  }

  /**
   * Fires a presence hint (typing / recording), swallowing any fault — it is a
   * cosmetic extra on top of the status message.
   */
  private async fireChatAction(action: ChatAction): Promise<void> {
    try {
      await this.vendor.sendChatAction(this.target, action);
    } catch (error) {
      this.logSurfaceFault('send chat action', error);
    }
  }

  /**
   * Advances the StatusSession phase, swallowing a Redis fault (the phase label is
   * advisory; a missed advance never breaks the turn).
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
 * L9 live-status animator (ADR 0053). Factory for per-turn {@link StatusAnimation}
 * handles — the only assistant-side owner of the one per-turn status message (the
 * real reply morph still flows through {@link ReplyPresenter}, which edits that
 * same message). It resolves the locale from the inbound signals, injects the
 * (sole) vendor connector + StatusSessionStore, and hands back a handle the turn
 * lifecycle drives. Every produced handle is degrade-never-throw.
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
   * Begins a live-status surface for a turn and returns its handle. Opens the
   * (idempotent) StatusSession and posts the initial loading message before
   * returning, injecting the spinner tick interval (R1 / ADR 0057) from config.
   * The caller drives voice/loading and MUST {@link StatusAnimation.finalize} in a
   * `finally`.
   */
  async begin(input: StatusAnimationInput): Promise<StatusAnimation> {
    const animation = new StatusAnimation(
      this.vendor,
      this.statusSessions,
      input,
      this.resolveLocale(input),
      this.config.statusSpinnerIntervalMs,
    );

    await animation.open();

    return animation;
  }

  /**
   * Resolves the loading-status {@link StatusLocale} for a turn from the input's
   * locale signals (v2 Task 4 / ADR 0051; R2 / ADR 0055) via the single
   * {@link resolveVoiceStatusLocale} chain: STT language → message-text detection →
   * `language_code` → borrowed prior-turn `priorLocale` → `en`. The borrowed
   * fallback is what gives a voice PRE-STT "Listening…" line (no STT lang, no text)
   * the conversation's language when the `language_code` is unsupported/absent.
   */
  private resolveLocale(input: StatusAnimationInput): StatusLocale {
    return resolveVoiceStatusLocale(
      input.sttLanguage,
      input.messageText,
      input.languageCode,
      detectMessageLanguage,
      input.priorLocale,
    );
  }
}
