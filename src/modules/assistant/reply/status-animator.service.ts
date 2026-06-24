import { Inject, Injectable, Logger } from '@nestjs/common';

import { detectMessageLanguage } from './detect-message-language';
import { DraftThrottle } from './draft-throttle';
import { escapeHtml } from './markdown-to-telegram-html';
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

/** FNV-1a 32-bit offset basis — the standard hash seed. */
const FNV_OFFSET_BASIS = 0x811c9dc5;

/** FNV-1a 32-bit prime multiplier. */
const FNV_PRIME = 0x01000193;

/**
 * Strips any trailing punctuation (comma, period, ellipsis — `…` or `...`) and
 * surrounding whitespace from a recap before it is escaped into the bare draft
 * text (ADR 0059). Telegram renders the draft bare and adds its own shimmer,
 * so a model-authored recap that ends in a comma/period/ellipsis would otherwise
 * read as a stray dangling mark; this normalizes it to a clean bare line.
 */
const stripTrailingPunctuation = (text: string): string =>
  text.replace(/[.,…\s]+$/u, '');

/**
 * Derives a stable, deterministic NON-ZERO 32-bit draft id from a turn key (the
 * `turnId` / correlation id) via FNV-1a (ADR 0059). Telegram requires a non-zero
 * integer draft id and animates the diffs when the SAME id is reused across a
 * turn's `sendMessageDraft` calls; deriving it from the turn key means a re-opened
 * (idempotent) surface computes the identical id without persisting it first. A
 * hash that lands on 0 is bumped to 1 so the non-zero contract always holds.
 */
const deriveDraftId = (turnKey: string): number => {
  let hash = FNV_OFFSET_BASIS;

  for (let index = 0; index < turnKey.length; index += 1) {
    hash ^= turnKey.charCodeAt(index);
    // `Math.imul` keeps the multiply in 32-bit space; `>>> 0` coerces to unsigned.
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }

  return hash === 0 ? 1 : hash;
};

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
 * A live per-turn status handle (ADR 0059, reversing ADR 0053's morph + ADR 0057's
 * ASCII spinner back to native Telegram message drafts). The surface depends on the
 * chat kind:
 *
 * - **PRIVATE chats** drive a single EPHEMERAL Telegram draft (`sendMessageDraft`)
 *   keyed by a stable non-zero {@link draftId} derived from the turn id. A draft is
 *   a ~30 s client-side preview that Telegram animates natively when re-called with
 *   the same id, carries NO buttons, and CANNOT be deleted — it self-expires. The
 *   lifecycle is: THINKING (a rotating loading word as PLAIN text, each rotation a
 *   draft re-send that also keeps the draft alive) → optional VOICE pre-STT
 *   ("Listening" plain line) → WORKING (ONLY the BARE recap text, no word above
 *   it; until the first recap the bare rotating word) → ANSWERING (the streamed
 *   answer snapshot as plain HTML, throttled via
 *   {@link DraftThrottle}). The turn is FINALISED by a fresh real `sendMessage`
 *   performed by the {@link ReplyPresenter}; the draft then self-expires. So
 *   {@link messageId} is ALWAYS null for a private turn — there is no real status
 *   message to morph; the reply sends fresh.
 *
 * - **NON-PRIVATE chats** keep the ADR 0053 fallback: ONE real message posted on
 *   {@link open}, edited with per-round recaps, and finally MORPHED into the answer
 *   by the reply (so {@link messageId} returns the real id). Drafts are private-chat
 *   only on the Bot API, so groups degrade to the in-place edit surface.
 *
 * Lifecycle (both surfaces): {@link open} → {@link showVoiceListening} (optional,
 * pre-STT) → {@link startLoading} (arms the loading-word rotation, private only) →
 * {@link showRecap} (between rounds) → {@link streamAnswer} (answer tokens) → the
 * reply sends/morphs the answer (in the turn runner via the presenter) →
 * {@link finalize} in the caller's `finally`. {@link settle} drains in-flight work
 * before the reply. Every vendor/Redis call is wrapped so a fault DEGRADES the
 * status surface and never throws into the turn (the webhook queue is `attempts:1`).
 */
export class StatusAnimation {
  private readonly logger = new Logger(StatusAnimation.name);

  private readonly target: SendTarget;

  private readonly isPrivate: boolean;

  private readonly draftId: number;

  // Coalescing rate limiter for the private-chat draft updates (ADR 0059 / ADR
  // 0012). Streamed-answer snapshots arrive far faster than Telegram's draft
  // re-call tolerance, so each draft send routes through this central cap (~2–5/s,
  // clamped). Constructed with the configured cap. Unused on the non-private edit
  // fallback but harmless there.
  private readonly draftThrottle: DraftThrottle;

  private session: StatusSession | null = null;

  private finalized = false;

  // Serializes status updates (recap / voice line / loading-word rotation /
  // streamed answer) so they apply in dispatch order AND can be drained via
  // {@link settle} before the reply sends/morphs the answer — closing the race
  // where a late in-flight update lands after, and reverts, the final answer.
  private pendingEdit: Promise<void> = Promise.resolve();

  // The loading-word rotation (ADR 0059). `wordTimer` is a `setInterval` handle
  // (unref'd so it never holds the process open), and `currentWord` the loading
  // word currently shown — each tick picks a fresh word (never the previous one)
  // and re-sends the draft (which doubles as the ~30 s draft keepalive).
  private wordTimer: NodeJS.Timeout | null = null;

  private currentWord: string | null = null;

  // The latest recap (ADR 0059): once set, the WORKING-phase draft shows ONLY this
  // recap as BARE, UNFORMATTED text (no `<blockquote>`, no loading word above it).
  // Null until the first recap; cleared once the answer starts streaming.
  private latestRecap: string | null = null;

  // Answer token streaming (ADR 0059). `latestSnapshot` holds the most recent FULL
  // answer text (never nulled until finalize) so {@link settle} can always re-send
  // the final state directly, bypassing the throttle's in-window coalescing — a
  // snapshot held only inside the throttle's pending job would otherwise be dropped
  // at drain time. `streaming` flips true on the first token so the loading-word
  // rotation is stopped exactly once (the answer is now the surface).
  private latestSnapshot: string | null = null;

  private streaming = false;

  constructor(
    private readonly vendor: ExternalVendorConnector,
    private readonly statusSessions: StatusSessionStore,
    private readonly input: StatusAnimationInput,
    private readonly locale: StatusLocale,
    private readonly wordIntervalMs: number,
    draftUpdatesPerSecond: number,
  ) {
    const chatType = input.chatType ?? ChatType.Private;

    this.target = { vendorChatId: input.vendorChatId, chatType };
    this.isPrivate = chatType === ChatType.Private;
    this.draftId = deriveDraftId(input.turnId);
    this.draftThrottle = new DraftThrottle(draftUpdatesPerSecond);
  }

  /**
   * The real message id of this turn's status message, or null. NON-PRIVATE turns
   * return the id of the one real status message so the reply MORPHS it (ADR 0053
   * fallback). PRIVATE turns ALWAYS return null — the draft is ephemeral and has no
   * real message, so the reply sends a FRESH final `sendMessage` (ADR 0059).
   */
  get messageId(): string | null {
    if (this.isPrivate) {
      return null;
    }

    return this.session?.vendorMessageId ?? null;
  }

  /**
   * Drains any in-flight status update (the serialized recap / voice-line / draft
   * edits) so the caller can send/morph the final reply without a late update
   * landing after — and reverting — the answer. The turn runner awaits this after
   * the loop, before the reply. Never throws: the update chain swallows its own
   * faults.
   */
  async settle(): Promise<void> {
    // Stop the loading-word rotation FIRST so no further word is queued onto the
    // chain while we drain it — the rotation MUST be dead before the reply sends
    // the answer, otherwise a late word would overwrite the draft preview.
    this.stopWordRotation();

    // Cancel the throttle (drop any pending trailing flush + its timer) and re-send
    // the LATEST full snapshot DIRECTLY onto the chain (ADR 0059), bypassing the
    // throttle's in-window coalescing — a snapshot held only inside the throttle's
    // pending job would otherwise be dropped silently when we stop draining here.
    this.draftThrottle.cancel();
    this.flushLatestSnapshot();

    await this.pendingEdit;
  }

  /**
   * Opens the (idempotent) Redis StatusSession and shows the first THINKING
   * surface. PRIVATE: seeds the derived draft id and sends the initial loading
   * -word draft (plain text). NON-PRIVATE: posts the ONE real status message
   * (ADR 0053 fallback) and captures its id. An idempotent re-open (lost NX race /
   * replay) reuses the existing surface. Degrades silently on any fault.
   */
  async open(): Promise<void> {
    try {
      this.session = await this.statusSessions.open({
        vendorChatId: this.input.vendorChatId,
        turnId: this.input.turnId,
        chatType: this.input.chatType ?? ChatType.Private,
        locale: this.locale,
        seedDraftId: this.isPrivate ? this.draftId : undefined,
      });
    } catch (error) {
      this.logSurfaceFault('open status session', error);

      return;
    }

    if (this.isPrivate) {
      this.currentWord = nextLoadingWord(this.locale, undefined);
      await this.sendDraft(this.currentWord);

      return;
    }

    if (this.session.vendorMessageId) {
      return;
    }

    await this.postInitialMessage(this.toPreBlock(this.loadingLine()));
  }

  /**
   * Shows the localized "listening to your voice" line while a voice note is
   * transcribed, plus a `record_voice` presence hint. PRIVATE: re-sends the draft
   * with the plain listening line (NOT a blockquote, NOT a `<pre>`, ADR 0059).
   * NON-PRIVATE: edits the one real message, wrapping the line in a `<pre>` block
   * to match its edit surface. Degrades silently.
   */
  async showVoiceListening(): Promise<void> {
    void this.fireChatAction(ChatAction.RecordVoice);

    const line = voiceListeningPhrase(this.locale);

    if (this.isPrivate) {
      await this.pushDraft(line);

      return;
    }

    await this.editStatus(this.toPreBlock(line));
  }

  /**
   * Advances the StatusSession to `Working`, fires a one-shot `typing` presence
   * hint, then ARMS the loading-word rotation (PRIVATE only, ADR 0059): a timer
   * swaps the draft to a fresh loading word every {@link wordIntervalMs} ms, each
   * swap also keeping the draft alive (resets Telegram's ~30 s TTL). NON-PRIVATE
   * has no rotation — its loading line already landed in {@link open}. Idempotent —
   * a no-op once finalized.
   */
  async startLoading(): Promise<void> {
    if (this.finalized) {
      return;
    }

    // Await the (degrade-never-throw) phase advance so the handle settles before
    // the caller drives the loop; the typing hint is a fire-and-forget extra.
    await this.advancePhaseSafe(StatusSessionPhase.Working);
    void this.fireChatAction(ChatAction.Typing);

    if (this.isPrivate) {
      this.startWordRotation();
    }
  }

  /**
   * Renders a one-sentence per-round recap so the user sees progress between tool
   * rounds. PRIVATE (ADR 0059): records it as the LATEST recap and re-sends the
   * draft as ONLY the BARE recap text — no `<blockquote>`, no loading word above it —
   * with its trailing punctuation stripped before escaping (Telegram renders the
   * draft bare). NON-PRIVATE: stops nothing and edits the one real message with a
   * `<pre>` recap (ADR 0053 fallback). A no-op once finalized or for empty text;
   * best-effort + degrade-never-throw — a missed recap leaves the current surface.
   */
  async showRecap(recap: string): Promise<void> {
    if (this.finalized || recap.length === 0) {
      return;
    }

    if (this.isPrivate) {
      this.latestRecap = recap;
      // Re-send the draft as ONLY the bare escaped recap text (no word line).
      await this.pushDraft(this.workingDraftText());

      return;
    }

    await this.editStatus(this.toPreBlock(recap));
  }

  /**
   * Streams the model's accumulated ANSWER text into the live surface as it is
   * written (ADR 0059). On the FIRST token it stops the loading-word rotation (the
   * answer is now the surface; the loading word + recap text are dropped),
   * then routes every snapshot through the {@link DraftThrottle} (PRIVATE) or the
   * ~1/sec coalescing edit (NON-PRIVATE). The partial answer is rendered as
   * HTML-escaped PLAIN text — the FINAL formatted answer is delivered separately by
   * the reply (a fresh send for private, a morph for non-private), so the two
   * reconcile. A no-op once finalized or for empty text.
   */
  streamAnswer(snapshot: string): void {
    if (this.finalized || snapshot.length === 0) {
      return;
    }

    this.latestSnapshot = snapshot;

    // First token: stop the loading-word rotation exactly once so it can never
    // overwrite the streamed text. The recap is dropped — the answer is
    // now the surface.
    if (!this.streaming) {
      this.streaming = true;
      this.latestRecap = null;
      this.stopWordRotation();
    }

    // Route through the throttle so rapid snapshots coalesce; the leading edge
    // shows the answer's first frame immediately and the rest are capped.
    this.queueSnapshot(snapshot);
  }

  /**
   * Settles the live draft to a final frame holding exactly `text` (PRIVATE only),
   * the Bot-API equivalent of a `clear_draft` — the Bot API has NO `clear_draft`
   * flag (it is an MTProto-client-only call bots cannot make), so we instead push
   * ONE last draft frame whose text IS the message that is about to be sent for
   * real, so Telegram replaces the stale draft preview with that message. Used by
   * the `ask_user` question path: unlike the answer (which streamed its full text
   * into the draft already), the question was never written into the draft, so it
   * would otherwise leave a lingering "ghost" preview. Stops the word rotation,
   * cancels the {@link DraftThrottle}, and sends one awaited `sendMessageDraft` with
   * the escaped text (same draft id, bypassing the throttle). A no-op for
   * NON-PRIVATE turns (the morph path already replaces their one real message) and
   * once finalized. Degrade-never-throw. NOTE: the visual replacement of the draft
   * preview by the real message MUST be confirmed on-device.
   */
  async settleDraftTo(text: string): Promise<void> {
    if (!this.isPrivate || this.finalized) {
      return;
    }

    // Kill the rotation + any pending throttled flush so nothing re-pushes a
    // loading word over this final frame, then send it directly (awaited).
    this.stopWordRotation();
    this.draftThrottle.cancel();

    this.pendingEdit = this.pendingEdit.then(() =>
      this.sendDraft(escapeHtml(text)),
    );

    await this.pendingEdit;
  }

  /**
   * Ends the status lifecycle: stops the loading-word rotation, cancels the draft
   * throttle (so no trailing flush leaks a timer), marks finalized, and clears the
   * Redis StatusSession. The draft is intentionally left untouched — it is
   * ephemeral and self-expires once the reply's fresh `sendMessage` lands (PRIVATE),
   * and the non-private message has by now been morphed into the answer
   * (NON-PRIVATE) — so there is nothing to retract or delete. Idempotent + never
   * throws; MUST be called in the caller's `finally` on every turn-exit path.
   */
  async finalize(): Promise<void> {
    this.stopWordRotation();
    this.draftThrottle.cancel();
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
   * The initial loading line for the NON-PRIVATE fallback: captures the first
   * locale word into {@link currentWord} and returns it bare (ADR 0053 surface
   * renders it inside a `<pre>` block). PRIVATE turns do not use this — they send
   * the bare word as a plain draft in {@link open}.
   */
  private loadingLine(): string {
    this.currentWord = nextLoadingWord(this.locale, undefined);

    return this.currentWord;
  }

  /**
   * Builds the WORKING-phase private draft text (ADR 0059). When a recap exists the
   * draft is ONLY that recap as BARE, UNFORMATTED text — NO `<blockquote>`, NO `<pre>`,
   * NO loading word above it — so the user reads the single latest progress line clean
   * (its trailing punctuation is stripped, then it is HTML-escaped — the draft is sent
   * as {@link OutboundFormat.Html}, so a literal `<`/`>`/`&` must be escaped to render
   * correctly — but with NO wrapping tags). Until the first recap it is just the bare
   * rotating loading word, which the rotation timer keeps re-pushing so the draft stays
   * within Telegram's ~30 s TTL (once a recap lands the rotation re-pushes the bare
   * recap frame instead of a word).
   */
  private workingDraftText(): string {
    if (this.latestRecap === null) {
      return this.currentWord ?? '';
    }

    return escapeHtml(stripTrailingPunctuation(this.latestRecap));
  }

  /**
   * Posts the ONE real status message for the NON-PRIVATE fallback (as HTML so the
   * `<pre>` loading line renders) and captures its id into the session, so recap
   * edits and the reply morph can target it. A no-op once finalized or if a message
   * id is already captured (idempotent re-open). Degrade-never-throw.
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
   * Wraps status text in an HTML `<pre>` code block (NON-PRIVATE fallback, ADR
   * 0053) after escaping it, so the monospace surface renders the recap / voice
   * line and never injects a tag Telegram rejects.
   */
  private toPreBlock(text: string): string {
    return `<pre>${escapeHtml(text)}</pre>`;
  }

  /**
   * Arms the loading-word rotation (PRIVATE only, ADR 0059): a `setInterval` that
   * picks a FRESH loading word (never the immediately-previous one) and re-sends
   * the draft — which also keeps the ~30 s ephemeral draft alive. Idempotent (a
   * prior timer is cleared first). The timer is `.unref()`'d so it never holds the
   * process open on its own (mirroring the user-lock watchdog). A no-op once the
   * answer is streaming (the surface is the answer, not a loading word).
   */
  private startWordRotation(): void {
    this.stopWordRotation();

    if (this.streaming) {
      return;
    }

    if (this.currentWord === null) {
      this.currentWord = nextLoadingWord(this.locale, undefined);
    }

    this.wordTimer = setInterval(() => {
      this.tickWord();
    }, this.wordIntervalMs);

    this.wordTimer.unref?.();
  }

  /**
   * Rotates the loading word one step and re-sends the draft (fire-and-forget — the
   * chain swallows its own faults). Picks a fresh word excluding the current one,
   * preserves the latest bare recap (the WORKING surface), and serves as the
   * draft keepalive. A no-op once the rotation has been stopped.
   */
  private tickWord(): void {
    if (this.wordTimer === null) {
      return;
    }

    this.currentWord = nextLoadingWord(
      this.locale,
      this.currentWord ?? undefined,
    );
    void this.pushDraft(this.workingDraftText());
  }

  /**
   * Stops the loading-word rotation: clears the interval and nulls the handle so
   * {@link settle}, {@link finalize}, and the first answer token can guarantee no
   * further word is queued. Idempotent — safe to call when no timer is armed.
   */
  private stopWordRotation(): void {
    if (this.wordTimer === null) {
      return;
    }

    clearInterval(this.wordTimer);
    this.wordTimer = null;
  }

  /**
   * Queues a live streamed answer snapshot onto the surface (ADR 0059), HTML
   * -escaped as PLAIN text (no `<pre>`/`<blockquote>` wrap — the partial answer
   * reads as prose until the reply reformats it). PRIVATE routes through the
   * throttled draft surface (rapid snapshots coalesce to the cap); NON-PRIVATE
   * through the serialized edit surface. Fire-and-forget — the chain swallows its
   * own fault. {@link settle} re-sends the final state directly via
   * {@link flushLatestSnapshot}, bypassing the throttle.
   */
  private queueSnapshot(snapshot: string): void {
    const escaped = escapeHtml(snapshot);

    if (this.isPrivate) {
      void this.pushDraft(escaped);

      return;
    }

    void this.editStatus(escaped);
  }

  /**
   * Re-sends the LATEST full answer snapshot DIRECTLY onto the serialized chain at
   * {@link settle} time (ADR 0059) — escaped plain text, BYPASSING the throttle's
   * in-window coalescing (the throttle was just cancelled) so the final answer text
   * always reaches the surface before the reply supersedes it. PRIVATE sends the
   * draft directly; NON-PRIVATE edits the message. A no-op when nothing streamed.
   */
  private flushLatestSnapshot(): void {
    if (this.latestSnapshot === null) {
      return;
    }

    const escaped = escapeHtml(this.latestSnapshot);

    if (this.isPrivate) {
      this.pendingEdit = this.pendingEdit.then(() => this.sendDraft(escaped));

      return;
    }

    void this.editStatus(escaped);
  }

  /**
   * Queues a PRIVATE draft update onto the serialized {@link pendingEdit} chain
   * (ADR 0059) so updates apply in dispatch order and {@link settle} can drain
   * them. The actual `sendMessageDraft` send is routed through the central
   * {@link DraftThrottle} so the per-second draft re-call cap is honoured. Returns
   * the chain tail so a caller may await it.
   */
  private pushDraft(text: string): Promise<void> {
    this.pendingEdit = this.pendingEdit.then(() =>
      this.draftThrottle.submit(() => this.sendDraft(text)),
    );

    return this.pendingEdit;
  }

  /**
   * Performs one `sendMessageDraft` send (ADR 0059) with the stable non-zero draft
   * id, as HTML so an escaped recap / escaped answer renders. A no-op once
   * finalized (checked at EXECUTION time, so a queued update that runs after
   * finalize never re-sends a draft over the delivered answer). Degrade-never
   * -throw — a draft fault degrades the surface, never the turn.
   */
  private async sendDraft(text: string): Promise<void> {
    if (this.finalized) {
      return;
    }

    try {
      await this.vendor.sendMessageDraft(this.target, {
        draftId: this.draftId,
        text,
        format: OutboundFormat.Html,
      });
    } catch (error) {
      this.logSurfaceFault('send status draft', error);
    }
  }

  /**
   * Edits the one NON-PRIVATE status message in place (ADR 0053 fallback),
   * SERIALIZED behind any prior edit via {@link pendingEdit} so updates apply in
   * dispatch order and {@link settle} can drain them. The surface is pre-wrapped /
   * escaped HTML, so the edit carries {@link OutboundFormat.Html}. Returns the chain
   * tail so a fire-and-forget caller may await it.
   */
  private editStatus(text: string): Promise<void> {
    this.pendingEdit = this.pendingEdit.then(() => this.runStatusEdit(text));

    return this.pendingEdit;
  }

  /**
   * Performs one NON-PRIVATE status edit (as HTML). A no-op once finalized (checked
   * at EXECUTION time, so a queued update that runs after finalize never re-posts)
   * or when no status message was posted (the initial send failed) — the turn still
   * answers via a fresh reply message. A benign "message is not modified" 400 is
   * treated as success by the connector. Degrade-never-throw.
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
   * cosmetic extra on top of the status surface.
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
 * L9 live-status animator (ADR 0059, reversing 0053/0057). Factory for per-turn
 * {@link StatusAnimation} handles — the only assistant-side owner of the per-turn
 * status surface (a native Telegram draft in private chats, the one-message edit
 * fallback in groups). The real final reply still flows through
 * {@link ReplyPresenter}. It resolves the locale from the inbound signals, injects
 * the (sole) vendor connector + StatusSessionStore + config knobs, and hands back a
 * handle the turn lifecycle drives. Every produced handle is degrade-never-throw.
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
   * (idempotent) StatusSession and shows the initial THINKING surface before
   * returning, injecting the loading-word rotation interval and the draft-update
   * cap from config (ADR 0059). The caller drives voice/loading and MUST
   * {@link StatusAnimation.finalize} in a `finally`.
   */
  async begin(input: StatusAnimationInput): Promise<StatusAnimation> {
    const animation = new StatusAnimation(
      this.vendor,
      this.statusSessions,
      input,
      this.resolveLocale(input),
      this.config.statusWordIntervalMs,
      this.config.draftUpdatesPerSecond,
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
