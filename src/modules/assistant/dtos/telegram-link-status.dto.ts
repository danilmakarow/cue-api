import { ApiProperty } from '@nestjs/swagger';

/**
 * Swagger documentation shape for the Telegram link state returned by the
 * `/assistant/link` endpoints. Mirrors the `TelegramLinkStatus` the linking
 * service returns; declared as a class so `@ApiProperty` can describe it.
 */
export class TelegramLinkStatusDto {
  @ApiProperty({ description: 'Whether this user has a live Telegram link.' })
  linked: boolean;

  @ApiProperty({ nullable: true, example: 'jane_doe' })
  telegramUsername: string | null;

  @ApiProperty({ format: 'date-time', nullable: true })
  linkedAt: string | null;
}
