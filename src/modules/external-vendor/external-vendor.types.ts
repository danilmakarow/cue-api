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
