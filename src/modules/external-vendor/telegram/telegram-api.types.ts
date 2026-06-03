/**
 * Minimal Telegram Bot API wire types — only the fields this connector reads or
 * sends. Kept private to the Telegram connector; nothing outside this folder
 * should import vendor wire shapes (the pipeline uses the normalized contract).
 *
 * Reference: https://core.telegram.org/bots/api
 */

/** A Telegram chat (only the id is used). */
export interface TelegramChat {
  id: number;
}

/** A Telegram user (only the id is used). */
export interface TelegramUser {
  id: number;
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

/** Generic Telegram API response envelope. */
export interface TelegramApiResponse<TResult> {
  ok: boolean;
  result?: TResult;
  description?: string;
  error_code?: number;
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
