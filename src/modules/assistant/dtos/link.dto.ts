import { IsString, MinLength } from 'class-validator';

/**
 * Body of `POST /assistant/link` — the single-use nonce the iOS app received on
 * `/start` and is now redeeming over an authenticated session to bind the
 * Telegram chat to the signed-in user.
 */
export class LinkTelegramDto {
  @IsString()
  @MinLength(1)
  code: string;
}
