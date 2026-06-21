import { timingSafeEqual } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { ExternalVendorConnector } from '../external-vendor-connector.abstract';
import {
  ExternalVendorConfig,
  TelegramVendorConfig,
} from '../external-vendor.config';
import {
  AcknowledgeOptions,
  ChatAction,
  ChatType,
  EditMessage,
  ExternalVendor,
  InboundKind,
  MediaPayload,
  MediaRef,
  MessageDraft,
  NormalizedInboundMessage,
  OutboundActions,
  OutboundFormat,
  OutboundKeyboardMessage,
  OutboundMessage,
  ReplyKeyboardMarkup,
  SendTarget,
  VendorCapabilities,
  VendorMessageRef,
  WebhookJob,
  WebhookRequest,
} from '../external-vendor.types';
import {
  TelegramApiResponse,
  TelegramInlineKeyboardButton,
  TelegramFile,
  TelegramMessage,
  TelegramReplyKeyboardMarkup,
  TelegramReplyKeyboardRemove,
  TelegramUpdate,
} from './telegram-api.types';

/** Header Telegram sets on every webhook POST carrying the shared secret. */
const SECRET_TOKEN_HEADER = 'x-telegram-bot-api-secret-token';

/** Updates we ask Telegram to deliver; keeps the webhook payload focused. */
const ALLOWED_UPDATES = ['message', 'callback_query'];

/** Fallback MIME when a downloaded file has no discernible type. */
const DEFAULT_MEDIA_MIME = 'application/octet-stream';

/**
 * Telegram implementation of {@link ExternalVendorConnector} over the Bot API
 * using the global `fetch` (no SDK), in webhook mode.
 *
 * See `docs/specs/telegram-ai-assistant.md` and the task doc for wire details.
 */
@Injectable()
export class TelegramVendorConnector extends ExternalVendorConnector {
  private readonly config: TelegramVendorConfig;

  constructor(externalVendorConfig: ExternalVendorConfig) {
    super();
    this.config = externalVendorConfig.getTelegramConfig();
  }

  /**
   * Compares two secrets in constant time to avoid leaking length/content via
   * timing. Returns false when lengths differ.
   */
  private constantTimeEquals(expected: string, provided: string): boolean {
    const expectedBuffer = Buffer.from(expected, 'utf8');
    const providedBuffer = Buffer.from(provided, 'utf8');

    if (expectedBuffer.length !== providedBuffer.length) {
      return false;
    }

    return timingSafeEqual(expectedBuffer, providedBuffer);
  }

  /**
   * Reads a header case-insensitively (Node lowercases incoming header keys,
   * but we normalize defensively for callers that pass raw casing).
   */
  private readHeader(
    headers: Record<string, string | undefined>,
    name: string,
  ): string | undefined {
    const direct = headers[name];

    if (direct !== undefined) {
      return direct;
    }

    const lowerName = name.toLowerCase();
    const match = Object.keys(headers).find(
      (key) => key.toLowerCase() === lowerName,
    );

    return match ? headers[match] : undefined;
  }

  /**
   * Builds a Bot API method URL: `<apiBase>/bot<token>/<method>`.
   */
  private apiUrl(method: string): string {
    return `${this.config.apiBase}/bot${this.config.botToken}/${method}`;
  }

  /**
   * Builds the file-download URL: `<apiBase>/file/bot<token>/<filePath>`.
   */
  private fileUrl(filePath: string): string {
    return `${this.config.apiBase}/file/bot${this.config.botToken}/${filePath}`;
  }

  /**
   * POSTs a JSON body to a Bot API method and returns the parsed `result`,
   * throwing when the transport fails or Telegram reports `ok: false`.
   */
  private async callApi<TResult>(
    method: string,
    body: Record<string, unknown>,
  ): Promise<TResult | undefined> {
    const response = await fetch(this.apiUrl(method), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`Telegram ${method} failed with HTTP ${response.status}`);
    }

    const payload = (await response.json()) as TelegramApiResponse<TResult>;

    if (!payload.ok) {
      throw new Error(
        `Telegram ${method} rejected: ${payload.description ?? 'unknown error'}`,
      );
    }

    return payload.result;
  }

  /**
   * Maps a normalized {@link OutboundFormat} to a Telegram `parse_mode`, or
   * `undefined` for plain text.
   */
  private toParseMode(format?: OutboundFormat): string | undefined {
    if (format === OutboundFormat.Markdown) {
      return 'MarkdownV2';
    }

    return undefined;
  }

  /**
   * Converts normalized button rows into Telegram inline keyboard rows.
   */
  private toInlineKeyboard(
    rows: OutboundActions['buttons'],
  ): TelegramInlineKeyboardButton[][] {
    return rows.map((row) =>
      row.map((button) => ({
        text: button.label,
        callback_data: button.callbackData,
      })),
    );
  }

  /**
   * Maps Telegram's `chat.type` string onto the normalized {@link ChatType}, or
   * `undefined` when absent / unrecognized. Drives the draft private-chat gate.
   */
  private toChatType(rawType: string | undefined): ChatType | undefined {
    switch (rawType) {
      case 'private':
        return ChatType.Private;
      case 'group':
        return ChatType.Group;
      case 'supergroup':
        return ChatType.Supergroup;
      case 'channel':
        return ChatType.Channel;
      default:
        return undefined;
    }
  }

  /**
   * Maps a normalized {@link ChatAction} onto its Telegram `sendChatAction` wire
   * value (the enum values already match the Bot API strings).
   */
  private toTelegramChatAction(action: ChatAction): string {
    return action;
  }

  /**
   * Builds the Telegram `reply_markup` for a persistent reply keyboard or the
   * remove sentinel. Persistent keyboards always set `is_persistent` +
   * `resize_keyboard` (Bot API 6.4) so they stay docked and sized to content.
   */
  private toReplyKeyboardMarkup(
    markup: ReplyKeyboardMarkup,
  ): TelegramReplyKeyboardMarkup | TelegramReplyKeyboardRemove {
    if ('remove' in markup) {
      return { remove_keyboard: true };
    }

    return {
      keyboard: markup.buttons.map((row) =>
        row.map((button) => ({ text: button.label })),
      ),
      is_persistent: true,
      resize_keyboard: true,
    };
  }

  /**
   * Builds a {@link VendorMessageRef} from a sent Telegram message, stringifying
   * `message_id` for the bigint-as-string convention. Throws when the response
   * carried no message.
   */
  private toMessageRef(sent: TelegramMessage | undefined): VendorMessageRef {
    if (!sent) {
      throw new Error('Telegram sendMessage returned no message');
    }

    return { vendorMessageId: String(sent.message_id) };
  }

  /**
   * Normalizes a Telegram message (text/command/voice). Returns `null` for a
   * message that carries nothing we handle.
   */
  private normalizeMessage(
    update: TelegramUpdate,
    message: TelegramMessage,
  ): NormalizedInboundMessage | null {
    const base = {
      vendorChatId: String(message.chat.id),
      vendorUserId: message.from ? String(message.from.id) : '',
      dedupeId: String(update.update_id),
      chatType: this.toChatType(message.chat.type),
    };

    if (message.voice) {
      return {
        ...base,
        kind: InboundKind.Voice,
        media: {
          vendorFileId: message.voice.file_id,
          mimeHint: message.voice.mime_type,
        },
      };
    }

    if (typeof message.text === 'string') {
      if (message.text.startsWith('/')) {
        const parts = message.text.slice(1).split(/\s+/).filter(Boolean);
        const [command, ...commandArgs] = parts;

        return {
          ...base,
          kind: InboundKind.Command,
          command,
          commandArgs,
        };
      }

      return {
        ...base,
        kind: InboundKind.Text,
        text: message.text,
      };
    }

    return null;
  }

  /**
   * Normalizes a Telegram callback query (inline button tap).
   */
  private normalizeCallback(
    update: TelegramUpdate,
  ): NormalizedInboundMessage | null {
    const callback = update.callback_query;

    if (!callback) {
      return null;
    }

    const vendorChatId = callback.message
      ? String(callback.message.chat.id)
      : '';

    return {
      kind: InboundKind.Callback,
      vendorChatId,
      vendorUserId: String(callback.from.id),
      dedupeId: String(update.update_id),
      callbackData: callback.data,
      callbackId: callback.id,
      chatType: callback.message
        ? this.toChatType(callback.message.chat.type)
        : undefined,
    };
  }

  /** The vendor this connector implements. */
  get vendor(): ExternalVendor {
    return ExternalVendor.Telegram;
  }

  /** Telegram supports voice notes, inline buttons, and callbacks. */
  get capabilities(): VendorCapabilities {
    return {
      supportsVoice: true,
      supportsInlineButtons: true,
      supportsCallbacks: true,
    };
  }

  /**
   * Authenticates a webhook request by constant-time comparing the
   * `X-Telegram-Bot-Api-Secret-Token` header against the configured secret.
   * AUTH ONLY — no body parsing or IO. Returns false on a missing/mismatched
   * secret.
   */
  acceptWebhook(request: WebhookRequest): boolean {
    const provided = this.readHeader(request.headers, SECRET_TOKEN_HEADER);

    if (!provided) {
      return false;
    }

    return this.constantTimeEquals(this.config.webhookSecret, provided);
  }

  /**
   * Parses the enqueued raw update and normalizes it into a
   * {@link NormalizedInboundMessage}, or `null` for updates we ignore.
   */
  // eslint-disable-next-line @typescript-eslint/require-await -- contract requires Promise<>; Telegram normalization is synchronous
  async handleWebhook(
    job: WebhookJob,
  ): Promise<NormalizedInboundMessage | null> {
    const update = JSON.parse(job.rawBody.toString('utf8')) as TelegramUpdate;

    if (update.callback_query) {
      return this.normalizeCallback(update);
    }

    if (update.message) {
      return this.normalizeMessage(update, update.message);
    }

    return null;
  }

  /**
   * Downloads media bytes on demand: `getFile` to resolve the file path, then
   * downloads from the file endpoint. Returns the bytes and resolved MIME type.
   */
  async fetchMedia(ref: MediaRef): Promise<MediaPayload> {
    const file = await this.callApi<TelegramFile>('getFile', {
      file_id: ref.vendorFileId,
    });

    if (!file?.file_path) {
      throw new Error(
        `Telegram getFile returned no file_path for ${ref.vendorFileId}`,
      );
    }

    const response = await fetch(this.fileUrl(file.file_path));

    if (!response.ok) {
      throw new Error(
        `Telegram file download failed with HTTP ${response.status}`,
      );
    }

    const arrayBuffer = await response.arrayBuffer();
    const mimeType =
      ref.mimeHint ??
      response.headers.get('content-type') ??
      DEFAULT_MEDIA_MIME;

    return { bytes: Buffer.from(arrayBuffer), mimeType };
  }

  /**
   * Sends a plain or markdown text message via `sendMessage`, returning a
   * reference to the created message.
   */
  async sendMessage(
    target: SendTarget,
    message: OutboundMessage,
  ): Promise<VendorMessageRef> {
    const sent = await this.callApi<TelegramMessage>('sendMessage', {
      chat_id: target.vendorChatId,
      text: message.text,
      parse_mode: this.toParseMode(message.format),
    });

    return this.toMessageRef(sent);
  }

  /**
   * Sends a prompt with an inline keyboard via `sendMessage` + `reply_markup`,
   * returning a reference to the created message.
   */
  async sendActions(
    target: SendTarget,
    actions: OutboundActions,
  ): Promise<VendorMessageRef> {
    const sent = await this.callApi<TelegramMessage>('sendMessage', {
      chat_id: target.vendorChatId,
      text: actions.text,
      reply_markup: {
        inline_keyboard: this.toInlineKeyboard(actions.buttons),
      },
    });

    return this.toMessageRef(sent);
  }

  /**
   * Sends a text message that also docks a persistent reply keyboard (or removes
   * the docked one) via `sendMessage` + `reply_markup`. Returns the created
   * message ref. Reply-keyboard taps later arrive as plain inbound text equal to
   * the button label — not callbacks.
   */
  async sendMessageWithKeyboard(
    target: SendTarget,
    message: OutboundKeyboardMessage,
  ): Promise<VendorMessageRef> {
    const sent = await this.callApi<TelegramMessage>('sendMessage', {
      chat_id: target.vendorChatId,
      text: message.text,
      parse_mode: this.toParseMode(message.format),
      reply_markup: this.toReplyKeyboardMarkup(message.replyKeyboard),
    });

    return this.toMessageRef(sent);
  }

  /**
   * Edits an already-sent message's text in place via `editMessageText`. The
   * non-private degraded path for live status / streaming (drafts are
   * private-only); shares the per-chat send budget, so callers throttle.
   */
  async editMessageText(target: SendTarget, edit: EditMessage): Promise<void> {
    await this.callApi('editMessageText', {
      chat_id: target.vendorChatId,
      message_id: Number(edit.vendorMessageId),
      text: edit.text,
      parse_mode: this.toParseMode(edit.format),
    });
  }

  /**
   * Shows an ephemeral presence hint via `sendChatAction` (typing…/recording…).
   * Fire-and-forget; Telegram clears it after a few seconds or the next message.
   */
  async sendChatAction(target: SendTarget, action: ChatAction): Promise<void> {
    await this.callApi('sendChatAction', {
      chat_id: target.vendorChatId,
      action: this.toTelegramChatAction(action),
    });
  }

  /**
   * Deletes a previously-sent message via `deleteMessage` — used to tidy a
   * transient status/control message once the turn finalizes.
   */
  async deleteMessage(
    target: SendTarget,
    vendorMessageId: string,
  ): Promise<void> {
    await this.callApi('deleteMessage', {
      chat_id: target.vendorChatId,
      message_id: Number(vendorMessageId),
    });
  }

  /**
   * Streams one ephemeral draft update via `sendMessageDraft`. GATED to private
   * chats: throws when `target.chatType` is set and not {@link ChatType.Private}
   * (non-private callers must degrade to {@link editMessageText}). The draft is a
   * ~30s preview animated client-side by re-calling with the same `draft_id`; an
   * empty `text` yields the native "Thinking…" shimmer; it carries no buttons and
   * MUST be finalized with a real {@link sendMessage} to persist (ADR 0012). The
   * central L9 throttle governs the call cadence (~2–5/s).
   */
  async sendMessageDraft(
    target: SendTarget,
    draft: MessageDraft,
  ): Promise<void> {
    if (target.chatType !== undefined && target.chatType !== ChatType.Private) {
      throw new Error(
        `sendMessageDraft is private-chat only; got chatType=${target.chatType}`,
      );
    }

    await this.callApi('sendMessageDraft', {
      chat_id: target.vendorChatId,
      draft_id: draft.draftId,
      text: draft.text,
      parse_mode: this.toParseMode(draft.format),
    });
  }

  /**
   * Acknowledges a callback via `answerCallbackQuery` so the client stops its
   * spinner, optionally showing a short toast.
   */
  async acknowledgeCallback(
    callbackId: string,
    options?: AcknowledgeOptions,
  ): Promise<void> {
    await this.callApi('answerCallbackQuery', {
      callback_query_id: callbackId,
      text: options?.text,
    });
  }

  /**
   * Registers the webhook via `setWebhook`, wiring the shared secret Telegram
   * will echo back in the `X-Telegram-Bot-Api-Secret-Token` header.
   */
  async registerWebhook(url: string): Promise<void> {
    await this.callApi('setWebhook', {
      url,
      secret_token: this.config.webhookSecret,
      allowed_updates: ALLOWED_UPDATES,
    });
  }

  /**
   * Removes the webhook registration via `deleteWebhook`.
   */
  async removeWebhook(): Promise<void> {
    await this.callApi('deleteWebhook', {});
  }
}
