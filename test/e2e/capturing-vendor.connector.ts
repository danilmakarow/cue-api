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
 * Terminal-signal rule (ADR 0053 "morph"): a turn no longer ends in a fresh
 * `sendMessage`. It posts ONE real status message (`sendMessage`, the loading
 * line), edits it with PLAIN per-round recaps (`editMessageText`, no format),
 * then MORPHS it ONE last time into the answer / ask via `editMessageText`
 * carrying `format === Html` or `buttons`. So a `nextSend()` waiter resolves
 * ONLY on a SUBSTANTIVE reply: `sendActions`, `sendMessageWithKeyboard`,
 * `acknowledgeCallback`, or an `editMessageText` with `format === Html` or
 * `buttons`. A bare `sendMessage` (loading line), a PLAIN `editMessageText`
 * (recap / voice line), a `sendMessageDraft`, and a `deleteMessage` (fallback
 * cleanup) are all RECORDED for inspection but do NOT resolve `nextSend()`.
 */
export class CapturingVendorConnector extends TelegramVendorConnector {
  private readonly captured: CapturedSend[] = [];

  /** FIFO queue of sends not yet consumed by a `nextSend()` waiter. */
  private readonly pending: CapturedSend[] = [];

  /** Resolver waiting for the next send, when a `nextSend()` outran the worker. */
  private waiter: Deferred | null = null;

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
   * Records a SUBSTANTIVE (turn-terminal) outbound send and either hands it to a
   * parked `nextSend()` waiter or buffers it for the next `nextSend()` call (so a
   * send that arrives before the test awaits is never lost).
   */
  private record(send: CapturedSend): void {
    this.captured.push(send);

    if (this.waiter) {
      const { resolve } = this.waiter;

      this.waiter = null;
      resolve(send);

      return;
    }

    this.pending.push(send);
  }

  /**
   * Records a NON-terminal framing send (the loading-line `sendMessage`, a plain
   * recap / voice `editMessageText`, a draft, or a fallback `deleteMessage`) into
   * `captured` for inspection ONLY — it never resolves a `nextSend()` waiter,
   * because the substantive reply now arrives as a later morph `editMessageText`.
   */
  private recordFraming(send: CapturedSend): void {
    this.captured.push(send);
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

  /** Every send recorded so far, in order (for multi-send assertions). */
  get sends(): readonly CapturedSend[] {
    return this.captured;
  }

  /**
   * Clears the capture log and any buffered/pending sends between tests so one
   * scenario's replies never leak into the next.
   */
  reset(): void {
    this.captured.length = 0;
    this.pending.length = 0;
    this.waiter = null;
  }

  /**
   * Captures a `sendMessage` instead of calling Telegram. Under ADR 0053 this is
   * the NON-terminal per-turn status loading line (e.g. `Crunching…`) whose id is
   * captured so later recaps + the final answer can morph it via
   * `editMessageText`; it is therefore framing, NOT a terminal turn signal, so it
   * is recorded but does NOT resolve a `nextSend()` waiter. (The rare genuine
   * fallback `sendMessage` — when an edit throws — is likewise non-terminal; its
   * paired morph still arrives as the substantive `editMessageText`.) Returns a
   * synthetic numeric message ref so the orchestrator's persistence path runs
   * unchanged.
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
   * Telegram — covers the live-status loading frames, the streamed-answer
   * preview, AND the empty-text collapse frame pushed on finalize (FIX 1 / ADR
   * 0049). A draft is NOT a terminal turn signal (the real reply is), so it is
   * logged into `captured` for inspection but does NOT resolve a `nextSend()`
   * waiter — a test still awaits the substantive `sendMessage`. Returns nothing,
   * matching the real connector.
   */
  async sendMessageDraft(
    target: SendTarget,
    draft: MessageDraft,
  ): Promise<void> {
    this.captured.push({ method: 'sendMessageDraft', target, payload: draft });
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
