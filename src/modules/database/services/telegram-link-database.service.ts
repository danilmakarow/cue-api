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
}
