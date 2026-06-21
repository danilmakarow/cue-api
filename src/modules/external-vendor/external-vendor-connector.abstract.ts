import {
  AcknowledgeOptions,
  ChatAction,
  EditMessage,
  ExternalVendor,
  MediaPayload,
  MediaRef,
  MessageDraft,
  NormalizedInboundMessage,
  OutboundActions,
  OutboundKeyboardMessage,
  OutboundMessage,
  SendTarget,
  VendorCapabilities,
  VendorMessageRef,
  WebhookJob,
  WebhookRequest,
} from './external-vendor.types';

/**
 * Vendor-agnostic connector contract. Concrete connectors (Telegram first)
 * translate between a vendor's wire format and the normalized DTOs in
 * `external-vendor.types.ts`. The rest of the pipeline depends only on this
 * abstract class and those types — never on a vendor SDK or raw payload.
 *
 * See `docs/adr/0007-provider-connector-abstraction.md`.
 */
export abstract class ExternalVendorConnector {
  /** The vendor this connector implements. */
  abstract readonly vendor: ExternalVendor;

  /** Feature flags this connector supports. */
  abstract readonly capabilities: VendorCapabilities;

  /**
   * Authenticates an inbound webhook request. AUTH ONLY: runs in the HTTP
   * request path before we return 200, so it must NOT parse the body, perform
   * IO, or cause side effects. Returns whether the request is authentic.
   */
  abstract acceptWebhook(request: WebhookRequest): boolean | Promise<boolean>;

  /**
   * Parses and normalizes a previously-enqueued raw webhook update. Runs in the
   * queue consumer, off the request path. Returns a `NormalizedInboundMessage`,
   * or `null` for updates that should be ignored.
   */
  abstract handleWebhook(
    job: WebhookJob,
  ): Promise<NormalizedInboundMessage | null>;

  /**
   * Downloads media bytes on demand (e.g. a voice note), referenced by a
   * `MediaRef` previously surfaced from `handleWebhook`.
   */
  abstract fetchMedia(ref: MediaRef): Promise<MediaPayload>;

  /**
   * Sends a plain or markdown text message to the target chat. Returns a
   * reference to the created message for tracing and later targeting.
   */
  abstract sendMessage(
    target: SendTarget,
    message: OutboundMessage,
  ): Promise<VendorMessageRef>;

  /**
   * Sends a prompt with inline action buttons (e.g. conflict resolution) to the
   * target chat. Returns a reference to the created message so the caller can
   * later edit its keyboard (e.g. mark a choice confirmed).
   */
  abstract sendActions(
    target: SendTarget,
    actions: OutboundActions,
  ): Promise<VendorMessageRef>;

  /**
   * Sends a plain/markdown text message that ALSO docks a persistent reply
   * keyboard or removes the docked one (`ReplyKeyboardMarkup`). The persistent
   * keyboard (`is_persistent` + `resize_keyboard`) stays below the input; a tap
   * arrives back as **plain inbound text equal to the button label** (NOT a
   * callback), so callers route taps by label text-equality. Swapping the
   * keyboard = sending a new message with different markup; the
   * `ReplyKeyboardRemove` sentinel clears it. Returns the created message ref.
   */
  abstract sendMessageWithKeyboard(
    target: SendTarget,
    message: OutboundKeyboardMessage,
  ): Promise<VendorMessageRef>;

  /**
   * Edits the text of an already-sent message in place (Telegram
   * `editMessageText`). This is the **non-private degraded path** for the
   * live-status / streaming surface — drafts are private-only — and it shares
   * the per-chat ~1 msg/s send budget, so callers MUST throttle their edits
   * (ADR 0012).
   */
  abstract editMessageText(
    target: SendTarget,
    edit: EditMessage,
  ): Promise<void>;

  /**
   * Shows an ephemeral "chat action" presence hint (typing…/recording…) in the
   * target chat. Fire-and-forget; the vendor clears it after a few seconds or on
   * the next message. Returns nothing — there is no message to reference.
   */
  abstract sendChatAction(
    target: SendTarget,
    action: ChatAction,
  ): Promise<void>;

  /**
   * Deletes a previously-sent message (Telegram `deleteMessage`). Used to tidy a
   * transient status/control message once the turn finalizes.
   */
  abstract deleteMessage(
    target: SendTarget,
    vendorMessageId: string,
  ): Promise<void>;

  /**
   * Streams ONE ephemeral draft update (Telegram `sendMessageDraft`).
   *
   * **CONTRACT (ADR 0012 / Verified Telegram facts):**
   * - **Private chat only.** This method MUST NOT be called for a non-private
   *   chat — the connector throws if `target.chatType` is set and not
   *   `ChatType.Private`. Non-private surfaces degrade to {@link editMessageText}.
   * - A draft is an **ephemeral ~30-second preview** that **never persists**. To
   *   keep it alive the caller re-calls within the TTL; to make the output
   *   durable the caller MUST **finalize with a real {@link sendMessage}** (the
   *   draft itself vanishes after 30 s).
   * - **Re-calling with the same `draft.draftId` IS the update mechanism** — the
   *   client animates the transition natively; there is no "edit draft" variant.
   * - An **empty `draft.text`** renders the native "Thinking…" shimmer.
   * - A draft **carries no buttons** — STOP / inline controls ride a separate
   *   real message.
   * - The **draft-call rate limit is undocumented**; all draft callers MUST go
   *   through the central L9 throttle (~2–5/s) rather than calling this directly
   *   in a tight loop.
   *
   * Returns nothing — the draft has no stable message id to thread back; the
   * caller owns the `draftId` it chose.
   */
  abstract sendMessageDraft(
    target: SendTarget,
    draft: MessageDraft,
  ): Promise<void>;

  /**
   * Acknowledges a callback (e.g. a button tap) so the client stops its loading
   * spinner, optionally showing the user a short toast.
   */
  abstract acknowledgeCallback(
    callbackId: string,
    options?: AcknowledgeOptions,
  ): Promise<void>;

  /**
   * Registers the inbound webhook with the vendor (idempotent), wiring the auth
   * secret that `acceptWebhook` later verifies.
   */
  abstract registerWebhook(url: string): Promise<void>;

  /**
   * Removes the webhook registration with the vendor.
   */
  abstract removeWebhook(): Promise<void>;
}
