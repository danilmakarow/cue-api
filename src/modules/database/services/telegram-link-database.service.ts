import { Injectable } from '@nestjs/common';

import { TelegramLink } from '@/modules/database/entities';
import { TelegramLinkRepository } from '@/modules/database/repositories';
import { BaseDatabaseService } from '@/modules/database/services/base-database.service';

/**
 * Database service for the TelegramLink entity.
 */
@Injectable()
export class TelegramLinkDatabaseService extends BaseDatabaseService<TelegramLink> {
  constructor(telegramLinkRepository: TelegramLinkRepository) {
    super(telegramLinkRepository);
  }

  /**
   * Finds the TelegramLink associated with the given user id.
   */
  findByUserId(userId: string) {
    return this.findOneBy({ userId });
  }

  /**
   * Finds the TelegramLink bound to the given Telegram chat id (string form, per
   * the bigint-as-string convention). Returns null when the chat is unlinked.
   */
  findByTelegramChatId(telegramChatId: string) {
    return this.findOneBy({ telegramChatId });
  }
}
