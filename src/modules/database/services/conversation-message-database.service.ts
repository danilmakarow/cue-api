import { Injectable } from '@nestjs/common';
import { Not } from 'typeorm';

import {
  ConversationMessage,
  ConversationMessageRole,
} from '@/modules/database/entities';
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
   *
   * `role = tool` rows (the persisted tool-loop audit trail) are excluded: the
   * model already saw those results live within the turn via `toolRounds`, so
   * re-feeding their raw JSON next turn only burns tokens and risks breaking the
   * user/assistant alternation the Messages API expects.
   */
  async findRecentWindow(
    conversationId: string,
    limit: number,
  ): Promise<ConversationMessage[]> {
    const newestFirst = await this.findAll({
      where: { conversationId, role: Not(ConversationMessageRole.TOOL) },
      order: { createdAt: 'DESC' },
      take: limit,
    });

    return [...newestFirst].reverse();
  }

  /**
   * Counts the conversational messages (excluding the `role = tool` audit trail)
   * — used to decide when the live window has grown past the re-summarize
   * threshold. Tool rows are excluded so the threshold tracks real turns.
   */
  async countInConversation(conversationId: string): Promise<number> {
    const messages = await this.findAll({
      where: { conversationId, role: Not(ConversationMessageRole.TOOL) },
    });

    return messages.length;
  }
}
