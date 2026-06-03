import { Injectable } from '@nestjs/common';

import { Conversation } from '@/modules/database/entities';
import { ConversationRepository } from '@/modules/database/repositories';
import { BaseDatabaseService } from '@/modules/database/services/base-database.service';

/**
 * Database service for the Conversation entity.
 */
@Injectable()
export class ConversationDatabaseService extends BaseDatabaseService<Conversation> {
  constructor(conversationRepository: ConversationRepository) {
    super(conversationRepository);
  }

  /**
   * Finds the conversation belonging to the given user. Returns null when the
   * user has no conversation yet (first inbound message).
   */
  findByUserId(userId: string) {
    return this.findOneBy({ userId });
  }
}
