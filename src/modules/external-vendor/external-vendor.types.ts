/**
 * Normalized, vendor-agnostic contract for the external-vendor connector.
 *
 * The rest of the AI-assistant pipeline imports ONLY from this file — never a
 * vendor SDK or a raw wire payload. See `docs/adr/0007-provider-connector-abstraction.md`.
 */

/**
 * Supported external chat vendors. Re-exported so callers reference the enum,
 * not raw strings. WhatsApp/Slack are expected to be added later.
 */
export enum ExternalVendor {
  Telegram = 'telegram',
}

/**
 * Inbound message kinds after normalization. The pipeline switches on this.
 */
export enum InboundKind {
  Text = 'text',
  Voice = 'voice',
  Command = 'command',
  Callback = 'callback',
}

/**
 * Outbound text formatting hint. Connectors map this to their vendor's scheme
 * (e.g. Telegram `parse_mode`). `Plain` means no special formatting.
 */
export enum OutboundFormat {
  Plain = 'plain',
  Markdown = 'markdown',
}

/**
 * Vendor chat kind, normalized from the vendor's own taxonomy. Drafts
 * (`sendMessageDraft`) are a **private-chat-only** primitive (see ADR 0012), so
 * the egress layer gates on `Private` before posting one and degrades elsewhere.
 */
export enum ChatType {
  Private = 'private',
  Group = 'group',
  Supergroup = 'supergroup',
  Channel = 'channel',
}

/**
 * Vendor "chat action" presence hints (mapped to Telegram `sendChatAction`).
 * Shown to the user as an ephemeral "typing…/recording…" status; the vendor
 * clears it on its own after a few seconds or when the next message arrives.
 */
export enum ChatAction {
  Typing = 'typing',
  RecordVoice = 'record_voice',
  UploadVoice = 'upload_voice',
}

/**
 * Capability flags advertised by a connector so the pipeline can degrade
 * gracefully on vendors that lack a feature.
 */
export interface VendorCapabilities {
  supportsVoice: boolean;
  supportsInlineButtons: boolean;
  supportsCallbacks: boolean;
}

/**
 * Reference to a piece of media surfaced on an inbound update. Media is never
 * inlined into the normalized message; it is downloaded on demand via
 * `fetchMedia(ref)`.
 */
export interface MediaRef {
  /** Vendor-specific media/file identifier (e.g. Telegram `file_id`). */
  vendorFileId: string;
  /** Best-effort MIME hint from the inbound update, if any. */
  mimeHint?: string;
}

/**
 * Downloaded media bytes plus the resolved MIME type. Returned by `fetchMedia`
 * and consumed by the STT step.
 */
export interface MediaPayload {
  bytes: Buffer;
  mimeType: string;
}

/**
 * What `acceptWebhook` sees in the HTTP request path: headers and the raw,
 * unparsed body. No parsed body — auth only. See ADR 0007.
 */
export interface WebhookRequest {
  headers: Record<string, string | undefined>;
  rawBody: Buffer;
}

/**
 * The enqueued payload `handleWebhook` parses off the request path. Kept
 * minimal and vendor-agnostic. See ADR 0007.
 */
export interface WebhookJob {
  rawBody: Buffer;
  /** ISO timestamp of when the webhook was received in the request path. */
  receivedAt: string;
}

/**
 * Target of an outbound message. String form because vendor chat ids are
 * bigint-ish (Telegram), mirroring the `telegram-link` convention.
 */
export interface SendTarget {
  /** Vendor chat id to deliver to (string form). */
  vendorChatId: string;
  /**
   * The kind of chat being targeted, when known. The egress layer passes it so
   * draft sends can be gated to {@link ChatType.Private} (ADR 0012); omit it for
   * the existing static-message paths, which are chat-kind-agnostic.
   */
  chatType?: ChatType;
}

/**
 * A normalized inbound message produced by `handleWebhook`. Optional fields are
 * populated per `kind` (see field docs).
 */
export interface NormalizedInboundMessage {
  kind: InboundKind;
  /** Vendor chat id (string form). */
  vendorChatId: string;
  /** Vendor user id (string form). */
  vendorUserId: string;
  /** Dedupe key (vendor update id, string form). */
  dedupeId: string;
  /** Present for `Text`. */
  text?: string;
  /** Present for `Command` (leading slash stripped). */
  command?: string;
  /** Present for `Command`: args split on whitespace. */
  commandArgs?: string[];
  /** Present for `Voice`. */
  media?: MediaRef;
  /** Present for `Callback`: the opaque callback payload string. */
  callbackData?: string;
  /** Present for `Callback`: the callback id (for `acknowledgeCallback`). */
  callbackId?: string;
  /**
   * The kind of chat this message arrived in. Drives the draft private-chat gate
   * (ADR 0012): a draft / live-status surface is only safe in a `Private` chat,
   * so the egress layer reads this before posting one. Absent on vendors that do
   * not surface chat kind.
   */
  chatType?: ChatType;
}

/**
 * A plain or markdown outbound text message.
 */
export interface OutboundMessage {
  text: string;
  /** Optional format hint; connector maps it to the vendor's scheme. */
  format?: OutboundFormat;
}

/**
 * A single inline action button. The `callbackData` round-trips opaquely back
 * to the pipeline when tapped.
 */
export interface OutboundActionButton {
  /** Button label shown to the user. */
  label: string;
  /** Opaque callback payload sent back when tapped. */
  callbackData: string;
}

/**
 * A prompt with inline action buttons (e.g. conflict resolution). Buttons are
 * laid out as rows. See ADR 0006.
 */
export interface OutboundActions {
  /** Prompt text shown above the buttons. */
  text: string;
  /** One or more rows of buttons. */
  buttons: OutboundActionButton[][];
}

/**
 * Options for acknowledging a callback (e.g. an optional toast shown to the
 * user, mapped to Telegram `answerCallbackQuery.text`).
 */
export interface AcknowledgeOptions {
  /** Optional short text shown to the user when the callback is acknowledged. */
  text?: string;
}

/**
 * Reference to a message the connector created on the vendor side. Returned by
 * message-creating outbound calls so the caller can persist it for tracing /
 * dedupe and later target the message (e.g. edit its inline keyboard).
 */
export interface VendorMessageRef {
  /** Vendor message id (string form, per the bigint-as-string convention). */
  vendorMessageId: string;
}

/**
 * Edit the text (and optional format) of an already-sent message in place,
 * mapped to Telegram `editMessageText`. The non-private degraded path for the
 * live-status / streaming surface (drafts are private-only); shares the per-chat
 * ~1 msg/s send budget, so callers must throttle (ADR 0012).
 */
export interface EditMessage {
  /** Vendor message id of the message to edit (string form). */
  vendorMessageId: string;
  /** New text to replace the message body with. */
  text: string;
  /** Optional format hint; connector maps it to the vendor's scheme. */
  format?: OutboundFormat;
}

/**
 * One ephemeral streaming-draft update (Telegram `sendMessageDraft`). The draft
 * is a **private-chat-only**, **~30-second** preview that the client **animates
 * natively** when re-called with the **same `draftId`** — that re-call IS the
 * update mechanism (there is no "edit draft"). An **empty `text`** renders the
 * native "Thinking…" shimmer. A draft **never persists**: it MUST be finalized
 * with a real {@link OutboundMessage} via `sendMessage` to survive the TTL, and
 * it carries **no buttons** (any inline control rides a separate real message).
 * The throttle on draft re-calls lives centrally in the L9 egress layer (the
 * draft-call rate limit is undocumented — capped conservatively, ADR 0012).
 *
 * See `docs/adr/0012-assistant-stateful-messenger-and-draft-streaming.md`.
 */
export interface MessageDraft {
  /**
   * Stable non-zero draft id for this turn's draft. Re-sending with the same id
   * animates the transition client-side; a new id starts a fresh draft.
   */
  draftId: number;
  /** Partial text so far; an empty string requests the native "Thinking…" shimmer. */
  text: string;
  /** Optional format hint; connector maps it to the vendor's scheme. */
  format?: OutboundFormat;
}

/**
 * A single persistent reply-keyboard button. Reply-keyboard taps arrive back as
 * **plain text equal to the label** (NOT a callback), so the label is the only
 * round-trip identifier — route taps by text-equality on it (Verified Telegram
 * facts, ADR 0012).
 */
export interface ReplyKeyboardButton {
  /** Button label, shown to the user AND echoed verbatim as inbound text on tap. */
  label: string;
}

/**
 * A persistent reply keyboard attached to an outbound message. Mapped to
 * Telegram `ReplyKeyboardMarkup` with `is_persistent: true` + `resize_keyboard:
 * true` (Bot API 6.4) so it stays docked below the input. Swapping the keyboard
 * means sending a new message with a different markup; removing it uses
 * {@link ReplyKeyboardRemove}.
 */
export interface ReplyKeyboard {
  /** One or more rows of persistent reply buttons. */
  buttons: ReplyKeyboardButton[][];
}

/**
 * Sentinel that removes any persistent reply keyboard currently docked for the
 * chat. Mapped to Telegram `ReplyKeyboardRemove` (`remove_keyboard: true`).
 */
export interface ReplyKeyboardRemove {
  remove: true;
}

/**
 * Reply-keyboard markup for an outbound message: either a persistent keyboard to
 * dock or the sentinel to remove the current one. `undefined` leaves whatever
 * keyboard is docked untouched.
 */
export type ReplyKeyboardMarkup = ReplyKeyboard | ReplyKeyboardRemove;

/**
 * A plain/markdown outbound message that additionally docks or removes a
 * persistent reply keyboard. Extends {@link OutboundMessage} so existing static
 * sends are unaffected — only callers that pass `replyKeyboard` change behaviour.
 */
export interface OutboundKeyboardMessage extends OutboundMessage {
  /** Persistent reply keyboard to dock, or the sentinel to remove the current one. */
  replyKeyboard: ReplyKeyboardMarkup;
}
