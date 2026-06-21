import { ExternalVendorConfig } from '@/modules/external-vendor/external-vendor.config';
import {
  AcknowledgeOptions,
  MessageDraft,
  OutboundActions,
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
 * exactly as in prod. Only the OUTBOUND side is replaced — `sendMessage` /
 * `sendActions` / `acknowledgeCallback` record the call into a `captured` log
 * and resolve the outstanding {@link nextSend} promise instead of hitting the
 * Telegram API. Because both `ExternalVendorConnectorFactory` (via its injected
 * `TelegramVendorConnector`) and the `ACTIVE_VENDOR_CONNECTOR` factory resolve
 * to the single `TelegramVendorConnector` provider, overriding that one provider
 * with this value points every ingress and egress path at this instance.
 *
 * `sendMessage` / `sendActions` are the deterministic terminal signal of a
 * finished turn (every reply / hold path ends in one), so a test awaits
 * {@link nextSend} to know the in-process worker has produced its reply.
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
   * Records an outbound send and either hands it to a parked `nextSend()` waiter
   * or buffers it for the next `nextSend()` call (so a send that arrives before
   * the test awaits is never lost).
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
   * Captures a text reply instead of calling Telegram. Returns a synthetic
   * message ref so the orchestrator's persistence path runs unchanged.
   */
  async sendMessage(
    target: SendTarget,
    message: OutboundMessage,
  ): Promise<VendorMessageRef> {
    this.record({ method: 'sendMessage', target, payload: message });

    return { vendorMessageId: this.nextVendorMessageId() };
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
