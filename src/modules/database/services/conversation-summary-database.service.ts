import { Injectable } from '@nestjs/common';

import { ConversationSummary } from '@/modules/database/entities';
import { ConversationSummaryRepository } from '@/modules/database/repositories';
import { BaseDatabaseService } from '@/modules/database/services/base-database.service';

/**
 * Database service for the ConversationSummary entity.
 */
@Injectable()
export class ConversationSummaryDatabaseService extends BaseDatabaseService<ConversationSummary> {
  constructor(conversationSummaryRepository: ConversationSummaryRepository) {
    super(conversationSummaryRepository);
  }

  /**
   * Returns the latest summary for a conversation, or null when none exists yet.
   */
  findLatest(conversationId: string): Promise<ConversationSummary | null> {
    return this.findOne({
      where: { conversationId },
      order: { createdAt: 'DESC' },
    });
  }
}
