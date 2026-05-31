import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';

import { TelegramLinkService } from './telegram-link.service';

/**
 * TelegramLink module wiring the Cue user to their Telegram chat (one-to-one).
 */
@Module({
  imports: [DatabaseModule],
  providers: [TelegramLinkService],
  exports: [TelegramLinkService],
})
export class TelegramLinkModule {}
