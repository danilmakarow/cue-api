import { Injectable } from '@nestjs/common';

import {
  Conversation,
  ConversationMessageContentType,
  ConversationMessageRole,
} from '@/modules/database/entities';
import {
  ConversationDatabaseService,
  ConversationMessageDatabaseService,
} from '@/modules/database/services';

/**
 * L3 session store for the user's perpetual conversation and its messages. It
 * owns the conversation lifecycle (get-or-create on first contact) and message
 * persistence (one row per turn, stamping the conversation's last-activity
 * time), keeping that persistence concern out of the orchestrator. Injects the
 * 3-layer {@link ConversationDatabaseService} + {@link
 * ConversationMessageDatabaseService} (downward L3 → L7).
 */
@Injectable()
export class ConversationStore {
  constructor(
    private readonly conversationDatabaseService: ConversationDatabaseService,
    private readonly conversationMessageDatabaseService: ConversationMessageDatabaseService,
  ) {}

  /**
   * Returns the user's perpetual conversation, creating it on first contact.
   */
  async getOrCreate(userId: string): Promise<Conversation> {
    const existing =
      await this.conversationDatabaseService.findByUserId(userId);

    if (existing) {
      return existing;
    }

    const created = this.conversationDatabaseService.createInstance({
      userId,
      lastActivityAt: new Date(),
    });

    return this.conversationDatabaseService.save(created);
  }

  /**
   * Persists one conversation message and stamps the conversation's
   * last-activity time.
   */
  async persistMessage(
    conversation: Conversation,
    role: ConversationMessageRole,
    contentType: ConversationMessageContentType,
    content: string,
    vendorMessageId: string | null,
  ): Promise<void> {
    const message = this.conversationMessageDatabaseService.createInstance({
      conversationId: conversation.id,
      role,
      contentType,
      content,
      vendorMessageId,
    });

    await this.conversationMessageDatabaseService.save(message);

    conversation.lastActivityAt = new Date();

    await this.conversationDatabaseService.save(conversation);
  }
}
