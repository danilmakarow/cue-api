/**
 * Minimal Telegram Bot API wire types — only the fields this connector reads or
 * sends. Kept private to the Telegram connector; nothing outside this folder
 * should import vendor wire shapes (the pipeline uses the normalized contract).
 *
 * Reference: https://core.telegram.org/bots/api
 */

/** A Telegram chat (id + kind; kind drives the draft private-chat gate). */
export interface TelegramChat {
  id: number;
  /** `private` | `group` | `supergroup` | `channel`; absent on some legacy updates. */
  type?: string;
}

/** A Telegram user (id + the optional IETF language tag the client reports). */
export interface TelegramUser {
  id: number;
  /** IETF language tag of the user's client (e.g. `en`, `uk`, `ru-RU`), if set. */
  language_code?: string;
}

/** A voice note attached to a message. */
export interface TelegramVoice {
  file_id: string;
  mime_type?: string;
}

/** An inbound message (text and/or voice). */
export interface TelegramMessage {
  message_id: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  voice?: TelegramVoice;
}

/** A callback produced by tapping an inline button. */
export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  data?: string;
  message?: TelegramMessage;
}

/** A Telegram update envelope delivered to the webhook. */
export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

/**
 * Optional response parameters Telegram attaches to some errors. On a 429
 * (`Too Many Requests`) `retry_after` is the suggested back-off in seconds.
 */
export interface TelegramResponseParameters {
  retry_after?: number;
  migrate_to_chat_id?: number;
}

/** Generic Telegram API response envelope. */
export interface TelegramApiResponse<TResult> {
  ok: boolean;
  result?: TResult;
  description?: string;
  error_code?: number;
  parameters?: TelegramResponseParameters;
}

/** Result of `getFile`: the path used to build the file download URL. */
export interface TelegramFile {
  file_id: string;
  file_path?: string;
}

/** A single inline keyboard button (callback variant only). */
export interface TelegramInlineKeyboardButton {
  text: string;
  callback_data: string;
}

/** `reply_markup` carrying an inline keyboard. */
export interface TelegramInlineKeyboardMarkup {
  inline_keyboard: TelegramInlineKeyboardButton[][];
}

/** A single persistent reply-keyboard button (text-only variant). */
export interface TelegramKeyboardButton {
  text: string;
}

/**
 * `reply_markup` carrying a persistent custom reply keyboard (Bot API 6.4). We
 * always set `is_persistent` + `resize_keyboard` so it stays docked and sized to
 * its buttons.
 */
export interface TelegramReplyKeyboardMarkup {
  keyboard: TelegramKeyboardButton[][];
  is_persistent: boolean;
  resize_keyboard: boolean;
}

/** `reply_markup` sentinel that removes the docked custom reply keyboard. */
export interface TelegramReplyKeyboardRemove {
  remove_keyboard: true;
}
