import { ExternalVendorConfig } from '@/modules/external-vendor/external-vendor.config';
import {
  AcknowledgeOptions,
  EditMessage,
  MessageDraft,
  OutboundActions,
  OutboundFormat,
  OutboundKeyboardMessage,
  OutboundMessage,
  SendTarget,
  VendorMessageRef,
} from '@/modules/external-vendor/external-vendor.types';
import { TelegramVendorConnector } from '@/modules/external-vendor/telegram/telegram-vendor.connector';

/** Which outbound method produced a captured send. */
export type CapturedSendMethod =
  | 'sendMessage'
  | 'sendActions'
  | 'sendMessageWithKeyboard'
  | 'sendMessageDraft'
  | 'editMessageText'
  | 'deleteMessage'
  | 'acknowledgeCallback';

/** One recorded outbound vendor call (the deterministic terminal turn signal). */
export interface CapturedSend {
  method: CapturedSendMethod;
  target: SendTarget | null;
  payload:
    | OutboundMessage
    | OutboundActions
    | OutboundKeyboardMessage
    | MessageDraft
    | EditMessage
    | AcknowledgeOptions
    | null;
}

/** A promise paired with its resolver, used to await the next outbound send. */
interface Deferred {
  promise: Promise<CapturedSend>;
  resolve: (send: CapturedSend) => void;
}

/**
 * Creates a fresh {@link Deferred}.
 */
const createDeferred = (): Deferred => {
  let resolve!: (send: CapturedSend) => void;
  const promise = new Promise<CapturedSend>((res) => {
    resolve = res;
  });

  return { promise, resolve };
};

/** A predicate over a captured send — the matcher a {@link PredicateWaiter} fires on. */
export type CapturedSendPredicate = (send: CapturedSend) => boolean;

/** A parked predicate await: the matcher plus the resolver to fire when it matches. */
interface PredicateWaiter {
  predicate: CapturedSendPredicate;
  resolve: (send: CapturedSend) => void;
}

/**
 * A capturing {@link TelegramVendorConnector} for the real-pipeline e2e harness.
 *
 * Ingress stays REAL: it inherits `acceptWebhook` (the constant-time secret
 * check) and `handleWebhook` (the Telegram → normalized-message parse) from the
 * base connector, so the controller's auth and the consumer's normalization run
 * exactly as in prod. Only the OUTBOUND side is replaced — every send method
 * records the call into a `captured` log instead of hitting the Telegram API.
 * Because both `ExternalVendorConnectorFactory` (via its injected
 * `TelegramVendorConnector`) and the `ACTIVE_VENDOR_CONNECTOR` factory resolve
 * to the single `TelegramVendorConnector` provider, overriding that one provider
 * with this value points every ingress and egress path at this instance.
 *
 * Terminal-signal rule — TWO worlds (ADR 0059 reverted the live surface from the
 * "morph one real message" model back to native drafts, but KEPT the morph as the
 * non-private fallback):
 *
 *  - PRIVATE chats (the harness default — `buildTextUpdate` omits `chat.type`, so
 *    ingress normalizes {@link ChatType.Private}): the live surface is an ephemeral
 *    `sendMessageDraft` (thinking word → bare recap text → streamed answer),
 *    and the TERMINAL reply is a FRESH real `sendMessage` (the finalised answer) or
 *    a fresh `sendActions` (an `ask_user` question with inline buttons). There is NO
 *    `editMessageText` morph and no draft clear — the draft self-expires.
 *  - NON-PRIVATE chats (group / supergroup, e.g. via a `chat.type` override): the
 *    retained ADR 0053 fallback — ONE real status `sendMessage` (the loading line)
 *    edited with `<pre>` per-round recaps, then MORPHED one last time into the
 *    answer / ask via `editMessageText` carrying `format === Html` or `buttons`.
 *
 * Two await strategies serve these two worlds:
 *
 *  - {@link nextSend} resolves on a SUBSTANTIVE MORPH reply: `sendActions`,
 *    `sendMessageWithKeyboard`, `acknowledgeCallback`, or an `editMessageText` with
 *    `format === Html` or `buttons` (and NOT a `<pre>` status frame). A bare framing
 *    `sendMessage` (loading line OR the private finalised answer), a `<pre>`
 *    `editMessageText` recap, a `sendMessageDraft`, and a `deleteMessage` are
 *    RECORDED for inspection but do NOT resolve it. This stays the seam for the
 *    non-private morph path and for the substantive-fresh-send paths (`ask_user`
 *    keyboard, reply-keyboard, callback ack).
 *  - {@link nextReply} resolves on the next captured send matching a caller-supplied
 *    predicate, scanning the WHOLE capture log first (so a send that arrived before
 *    the await is never missed) and parking otherwise. This is the PRIVATE-path seam:
 *    the finalised answer is a framing `sendMessage` that `nextSend()` never fires
 *    on, so a private test awaits it via `nextReply(isPrivateAnswer)` (or a custom
 *    text predicate). See {@link isPrivateAnswer}.
 */
export class CapturingVendorConnector extends TelegramVendorConnector {
  private readonly captured: CapturedSend[] = [];

  /** FIFO queue of sends not yet consumed by a `nextSend()` waiter. */
  private readonly pending: CapturedSend[] = [];

  /** Resolver waiting for the next send, when a `nextSend()` outran the worker. */
  private waiter: Deferred | null = null;

  /**
   * Indices into {@link captured} already consumed by a {@link nextReply} await, so
   * a matched reply is never returned twice. A `nextReply()` sweep skips these and a
   * just-matched send is added here, mirroring the FIFO consumption of `nextSend()`.
   */
  private readonly consumedReplyIndices = new Set<number>();

  /** Parked predicate awaits ({@link nextReply}), resolved as matching sends arrive. */
  private readonly predicateWaiters: PredicateWaiter[] = [];

  /**
   * Monotonic source for synthetic vendor message ids. The persisted
   * `conversation_message.vendorMessageId` column is Postgres `bigint`, and real
   * Telegram returns a NUMERIC `message_id` (stringified per the bigint-as-string
   * convention). A non-numeric id (e.g. `e2e-msg-1`) makes the orchestrator's
   * outbound-reply persist throw `invalid input syntax for type bigint`, so the
   * fake must mint numeric-string ids to exercise that path faithfully.
   */
  private vendorMessageIdCounter = 900_000_000;

  /**
   * Whether a piece of outbound text is a single top-level `<pre>…</pre>` status
   * frame (R1 / ADR 0057) — the signature the status surface (`toPreBlock`) wraps
   * the loading line / per-round recap / voice line in. The final answer morph is
   * HTML-CONVERTED markdown, which never wraps the WHOLE message in one `<pre>`
   * block, so this cleanly separates framing status edits from the terminal reply.
   * Tolerant of leading/trailing whitespace around the block.
   */
  private static isPreBlock(text: string): boolean {
    return /^\s*<pre>[\s\S]*<\/pre>\s*$/.test(text);
  }

  /**
   * Whether a captured send is the PRIVATE-path finalised answer (ADR 0059): a
   * FRESH real `sendMessage` carrying `format === Html` (the model's HTML-converted
   * answer), as opposed to the bare-text loading-line / plain-fallback `sendMessage`.
   * The private terminal answer is a fresh send (not a morph), so `nextSend()` never
   * fires on it — a private test awaits it via `nextReply(CapturingVendorConnector.
   * isPrivateAnswer)`. Static so specs can pass it as a predicate without an instance.
   */
  static isPrivateAnswer(send: CapturedSend): boolean {
    return (
      send.method === 'sendMessage' &&
      (send.payload as OutboundMessage | null)?.format === OutboundFormat.Html
    );
  }

  constructor(externalVendorConfig: ExternalVendorConfig) {
    super(externalVendorConfig);
  }

  /**
   * Returns the next synthetic, numeric vendor message id as a string, matching
   * the real connector's bigint-as-string `message_id` so the persisted reply
   * fits the `bigint` column.
   */
  private nextVendorMessageId(): string {
    this.vendorMessageIdCounter += 1;

    return String(this.vendorMessageIdCounter);
  }

  /**
   * Appends a send to the capture log and offers it to any parked
   * {@link nextReply} predicate await it satisfies. Both terminal sends
   * ({@link record}) and framing sends ({@link recordFraming}) — and the draft
   * frames — route through here, so a predicate await can match ANY captured send
   * (e.g. the private finalised answer `sendMessage`, which is framing) regardless
   * of the morph-only `nextSend()` classification. The first parked waiter whose
   * predicate matches (FIFO) wins and is removed; non-matching waiters stay parked.
   */
  private capture(send: CapturedSend): void {
    const sendIndex = this.captured.push(send) - 1;

    const matchedIndex = this.predicateWaiters.findIndex((waiter) =>
      waiter.predicate(send),
    );

    if (matchedIndex !== -1) {
      const [matched] = this.predicateWaiters.splice(matchedIndex, 1);

      // This send is now consumed by the predicate await; mark its index so a later
      // nextReply() sweep never re-offers it.
      this.consumedReplyIndices.add(sendIndex);
      matched.resolve(send);
    }
  }

  /**
   * Records a SUBSTANTIVE (turn-terminal MORPH) outbound send and either hands it to
   * a parked `nextSend()` waiter or buffers it for the next `nextSend()` call (so a
   * send that arrives before the test awaits is never lost). Also offered to any
   * {@link nextReply} predicate await via {@link capture}.
   */
  private record(send: CapturedSend): void {
    this.capture(send);

    if (this.waiter) {
      const { resolve } = this.waiter;

      this.waiter = null;
      resolve(send);

      return;
    }

    this.pending.push(send);
  }

  /**
   * Records a send that is NOT a morph terminal signal (the loading-line
   * `sendMessage`, the PRIVATE finalised-answer `sendMessage`, a `<pre>` recap
   * `editMessageText`, a draft, or a fallback `deleteMessage`) into `captured` for
   * inspection — it never resolves a `nextSend()` waiter. It IS offered to
   * {@link nextReply} predicate awaits via {@link capture}, so the private terminal
   * answer (framing here, but the real reply) can still be awaited deterministically.
   */
  private recordFraming(send: CapturedSend): void {
    this.capture(send);
  }

  /**
   * Resolves with the next outbound send, awaiting the in-process worker when
   * none has arrived yet. This is the primary async-wait strategy: the webhook
   * POST returns 200 immediately and the turn runs in the BullMQ worker, so the
   * test awaits the business-terminal send rather than a timer. The surrounding
   * jest `testTimeout` bounds the wait, surfacing a thrown/stuck turn as a
   * timeout rather than a hang.
   */
  nextSend(): Promise<CapturedSend> {
    const buffered = this.pending.shift();

    if (buffered) {
      return Promise.resolve(buffered);
    }

    this.waiter = createDeferred();

    return this.waiter.promise;
  }

  /**
   * Resolves with the next captured send (of ANY method) matching `predicate`,
   * sweeping the WHOLE capture log first — so a send that already arrived before the
   * await is matched immediately — and parking until one arrives otherwise. This is
   * the PRIVATE-path await seam (ADR 0059): the finalised answer is a fresh framing
   * `sendMessage` that {@link nextSend} never fires on, so a private test awaits the
   * real reply here, e.g. `nextReply(CapturingVendorConnector.isPrivateAnswer)` for
   * the finalised answer or `nextReply((send) => send.method === 'sendActions')` for
   * a fresh `ask_user` keyboard. Each matched send is consumed once (FIFO), so
   * successive `nextReply()` calls walk distinct sends. Bounded by jest's
   * `testTimeout`, surfacing a stuck turn as a timeout rather than a hang.
   */
  nextReply(predicate: CapturedSendPredicate): Promise<CapturedSend> {
    for (let index = 0; index < this.captured.length; index += 1) {
      if (this.consumedReplyIndices.has(index)) {
        continue;
      }

      const send = this.captured[index];

      if (predicate(send)) {
        this.consumedReplyIndices.add(index);

        return Promise.resolve(send);
      }
    }

    return new Promise<CapturedSend>((resolve) => {
      this.predicateWaiters.push({ predicate, resolve });
    });
  }

  /** Every send recorded so far, in order (for multi-send assertions). */
  get sends(): readonly CapturedSend[] {
    return this.captured;
  }

  /**
   * Clears the capture log and any buffered/pending/parked sends between tests so
   * one scenario's replies never leak into the next.
   */
  reset(): void {
    this.captured.length = 0;
    this.pending.length = 0;
    this.waiter = null;
    this.consumedReplyIndices.clear();
    this.predicateWaiters.length = 0;
  }

  /**
   * Captures a `sendMessage` instead of calling Telegram. This method now carries
   * TWO non-morph-terminal roles, both recorded as FRAMING (so neither resolves a
   * `nextSend()` waiter): (1) the NON-PRIVATE per-turn status loading line whose id
   * later recaps + the final answer morph via `editMessageText` (ADR 0053), and (2)
   * the PRIVATE-path FINALISED ANSWER — a fresh real `sendMessage` carrying
   * `format === Html` that replaces the self-expiring draft preview (ADR 0059).
   * Because the private answer is the REAL terminal reply yet arrives as framing, a
   * private test awaits it via {@link nextReply} ({@link isPrivateAnswer}) rather
   * than `nextSend()`. Returns a synthetic numeric message ref so the orchestrator's
   * persistence path runs unchanged.
   */
  async sendMessage(
    target: SendTarget,
    message: OutboundMessage,
  ): Promise<VendorMessageRef> {
    this.recordFraming({ method: 'sendMessage', target, payload: message });

    return { vendorMessageId: this.nextVendorMessageId() };
  }

  /**
   * Captures an `editMessageText` instead of calling Telegram. The morph surface
   * (ADR 0053 + 0057): the live STATUS frames (the loading line, the per-round
   * recap, the voice-listening line) are now ALL rendered as an HTML `<pre>…</pre>`
   * code block (R1 / ADR 0057), so the old "framing == no format" heuristic no
   * longer holds — a recap arrives as `format === Html`. The deterministic
   * SUBSTANTIVE signal is therefore narrowed: a `<pre>…</pre>` status frame is
   * FRAMING (recorded only), while a real reply — the final answer morph
   * (`format === Html`, the model's HTML-converted text, never a bare `<pre>`
   * wrapper), an `ask_user` morph (`buttons`), or the answered-question morph
   * (`clearButtons`) — is the terminal turn signal that resolves a `nextSend()`
   * waiter. A streamed partial-answer frame (HTML, NOT `<pre>`-wrapped) is the
   * answer-in-progress, so treating it as substantive is correct (the final morph
   * carries the same text). Returns nothing, matching the real connector.
   */
  async editMessageText(target: SendTarget, edit: EditMessage): Promise<void> {
    const isStatusFrame =
      edit.format === OutboundFormat.Html &&
      CapturingVendorConnector.isPreBlock(edit.text);
    const isSubstantive =
      !isStatusFrame &&
      (edit.format === OutboundFormat.Html ||
        edit.buttons !== undefined ||
        edit.clearButtons === true);
    const send: CapturedSend = {
      method: 'editMessageText',
      target,
      payload: edit,
    };

    if (isSubstantive) {
      this.record(send);

      return;
    }

    this.recordFraming(send);
  }

  /**
   * Captures a `deleteMessage` instead of calling Telegram — the fallback path
   * that tidies the stale loading line when an edit throws and a fresh
   * `sendMessage`/`sendActions` is posted instead. Framing only: recorded for
   * inspection, never a terminal turn signal. Returns nothing.
   */
  async deleteMessage(
    target: SendTarget,
    _vendorMessageId: string,
  ): Promise<void> {
    this.recordFraming({ method: 'deleteMessage', target, payload: null });
  }

  /**
   * Captures an inline-keyboard prompt (held-conflict ask) instead of calling
   * Telegram. Returns a synthetic message ref.
   */
  async sendActions(
    target: SendTarget,
    actions: OutboundActions,
  ): Promise<VendorMessageRef> {
    this.record({ method: 'sendActions', target, payload: actions });

    return { vendorMessageId: this.nextVendorMessageId() };
  }

  /**
   * Captures a reply-keyboard message (Story 16 / ADR 0045) instead of calling
   * Telegram — the deterministic keyboard-action paths (calendar render / keyboard
   * swap / disconnect) end in this send. Recorded as a substantive reply (NOT
   * framing), so a test can await it via `nextSend()` and assert the docked keyboard
   * markup. Returns a synthetic numeric message ref.
   */
  async sendMessageWithKeyboard(
    target: SendTarget,
    message: OutboundKeyboardMessage,
  ): Promise<VendorMessageRef> {
    this.record({
      method: 'sendMessageWithKeyboard',
      target,
      payload: message,
    });

    return { vendorMessageId: this.nextVendorMessageId() };
  }

  /**
   * Captures an ephemeral status draft (`sendMessageDraft`) instead of calling
   * Telegram — the PRIVATE-chat live surface (ADR 0059): the rotating loading word,
   * the bare per-round recap text, and the streamed-answer preview frames. A
   * draft is NOT a terminal turn signal (the fresh `sendMessage` answer is), so it
   * is logged into `captured` for inspection and offered to {@link nextReply}
   * predicate awaits but does NOT resolve a `nextSend()` waiter. Returns nothing,
   * matching the real connector.
   */
  async sendMessageDraft(
    target: SendTarget,
    draft: MessageDraft,
  ): Promise<void> {
    this.recordFraming({ method: 'sendMessageDraft', target, payload: draft });
  }

  /**
   * Captures a callback acknowledgement (button-tap spinner stop) instead of
   * calling Telegram.
   */
  async acknowledgeCallback(
    callbackId: string,
    options?: AcknowledgeOptions,
  ): Promise<void> {
    this.record({
      method: 'acknowledgeCallback',
      target: { vendorChatId: callbackId },
      payload: options ?? null,
    });
  }

  /**
   * No-op webhook registration — defence-in-depth against any boot-time
   * `setWebhook` egress even if `ASSISTANT_WEBHOOK_URL` were ever set.
   */
  async registerWebhook(): Promise<void> {
    // intentionally does nothing in e2e
  }

  /**
   * No-op webhook removal — never touches the Telegram API in e2e.
   */
  async removeWebhook(): Promise<void> {
    // intentionally does nothing in e2e
  }
}
