import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Stable, machine-readable error codes the Telegram-linking surface returns in a
 * typed body (M3). The iOS client branches on `code` — a persistent "bad code"
 * state vs a transient network/server error — so the string values are part of
 * the API contract and MUST NOT change once shipped.
 */
export enum TelegramLinkErrorCode {
  /** The redeemed nonce is unknown, expired, or already burned (single-use). */
  INVALID_LINK_CODE = 'INVALID_LINK_CODE',
}

/**
 * The typed response body for a rejected `POST /assistant/link` redemption (M3).
 * `code` is the stable discriminator the iOS client switches on; `message` is a
 * human-readable fallback for logs / generic display.
 */
export interface TelegramLinkErrorBody {
  code: TelegramLinkErrorCode;
  message: string;
}

/**
 * Thrown when `redeemNonce` is handed an invalid, expired, or already-burned
 * linking nonce (M3). Resolves to HTTP 422 with a typed `{ code, message }` body
 * so the iOS client can distinguish a permanently-bad code (show "this code is no
 * longer valid", do not retry) from a transient network failure (offer retry).
 * 422 (not 400) signals the request was well-formed but the referenced nonce is
 * no longer redeemable.
 */
export class InvalidLinkCodeException extends HttpException {
  constructor(
    message = 'This linking code is invalid, expired, or already used.',
  ) {
    const body: TelegramLinkErrorBody = {
      code: TelegramLinkErrorCode.INVALID_LINK_CODE,
      message,
    };

    super(body, HttpStatus.UNPROCESSABLE_ENTITY);
  }
}
