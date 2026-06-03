import { Injectable } from '@nestjs/common';

import { ConversationMessage } from '@/modules/database/entities';
import { ConversationMessageRepository } from '@/modules/database/repositories';
import { BaseDatabaseService } from '@/modules/database/services/base-database.service';

/**
 * Database service for the ConversationMessage entity.
 */
@Injectable()
export class ConversationMessageDatabaseService extends BaseDatabaseService<ConversationMessage> {
  constructor(conversationMessageRepository: ConversationMessageRepository) {
    super(conversationMessageRepository);
  }

  /**
   * Returns the most recent `limit` messages of a conversation in chronological
   * (oldest-first) order — the verbatim recent window (ADR 0005 tier 1). Reads
   * newest-first (so the limit keeps the latest turns) then reverses so the
   * prompt keeps natural turn order.
   */
  async findRecentWindow(
    conversationId: string,
    limit: number,
  ): Promise<ConversationMessage[]> {
    const newestFirst = await this.findAll({
      where: { conversationId },
      order: { createdAt: 'DESC' },
      take: limit,
    });

    return [...newestFirst].reverse();
  }

  /**
   * Counts the messages in a conversation — used to decide when the live window
   * has grown past the re-summarize threshold.
   */
  async countInConversation(conversationId: string): Promise<number> {
    const messages = await this.findAll({ where: { conversationId } });

    return messages.length;
  }
}
