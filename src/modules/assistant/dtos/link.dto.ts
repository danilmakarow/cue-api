import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

/**
 * Body of `POST /assistant/link` — the single-use nonce the iOS app received on
 * `/start` and is now redeeming over an authenticated session to bind the
 * Telegram chat to the signed-in user.
 */
export class LinkTelegramDto {
  @ApiProperty({
    description: 'Single-use link nonce the iOS app received on /start.',
    example: 'b3f1c2b7-9a4d-4f3a-bb2e-1d5c6e7f8a90',
  })
  @IsString()
  @MinLength(1)
  code: string;
}
