import { Inject, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';

import { AssistantConfig } from '../assistant.config';
import { SUMMARY_SYSTEM_PROMPT } from '../assistant.prompts';
import { AiConnector } from '@/modules/ai/ai-connector.abstract';
import { ACTIVE_AI_CONNECTOR } from '@/modules/ai/ai.module';
import { AiModelRole, PromptRole } from '@/modules/ai/ai.types';
import { ConversationMessage } from '@/modules/database/entities';
import {
  ConversationDatabaseService,
  ConversationMessageDatabaseService,
  ConversationSummaryDatabaseService,
} from '@/modules/database/services';

/** Structured shape the background model returns for a re-summary. */
const summaryResultSchema = z.object({
  summary: z.string(),
});

/**
 * Maintains the rolling conversation summary (ADR 0005 tier 2) on the cheap
 * BACKGROUND model. Runs after a reply, off the request path, and only when the
 * live message window has grown past the configured threshold — folding the
 * previous summary plus the conversation into a new bounded summary and pointing
 * `Conversation.latestSummaryId` at it.
 */
@Injectable()
export class SummarizerService {
  private readonly logger = new Logger(SummarizerService.name);

  constructor(
    @Inject(ACTIVE_AI_CONNECTOR) private readonly ai: AiConnector,
    private readonly config: AssistantConfig,
    private readonly conversationDatabaseService: ConversationDatabaseService,
    private readonly conversationMessageDatabaseService: ConversationMessageDatabaseService,
    private readonly conversationSummaryDatabaseService: ConversationSummaryDatabaseService,
  ) {}

  /**
   * Renders the messages to be summarized into a compact transcript for the
   * background model.
   */
  private static renderTranscript(messages: ConversationMessage[]): string {
    return messages
      .map((message) => `${message.role}: ${message.content}`)
      .join('\n');
  }

  /**
   * Re-summarizes the conversation when its message count crosses the threshold.
   * No-ops below the threshold so the cached prefix stays stable between
   * summarizations (ADR 0004). Failures are logged and swallowed — a missed
   * summary never breaks the user-facing turn.
   */
  async maybeSummarize(conversationId: string): Promise<void> {
    try {
      const messageCount =
        await this.conversationMessageDatabaseService.countInConversation(
          conversationId,
        );

      if (messageCount < this.config.summarizeThreshold) {
        return;
      }

      const messages =
        await this.conversationMessageDatabaseService.findRecentWindow(
          conversationId,
          this.config.summarizeThreshold,
        );

      if (messages.length === 0) {
        return;
      }

      const previousSummary =
        await this.conversationSummaryDatabaseService.findLatest(
          conversationId,
        );
      const transcript = SummarizerService.renderTranscript(messages);
      const priorText = previousSummary
        ? `Previous summary:\n${previousSummary.summaryText}\n\n`
        : '';

      const result = await this.ai.completeStructured(
        {
          modelRole: AiModelRole.BACKGROUND,
          system: [{ role: PromptRole.USER, content: SUMMARY_SYSTEM_PROMPT }],
          messages: [
            {
              role: PromptRole.USER,
              content: `${priorText}Recent turns:\n${transcript}`,
            },
          ],
        },
        summaryResultSchema,
      );

      const newest = messages[messages.length - 1];
      const summary = this.conversationSummaryDatabaseService.createInstance({
        conversationId,
        summaryText: result.summary,
        coversUpToMessageId: newest.id,
      });
      const saved = await this.conversationSummaryDatabaseService.save(summary);

      const conversation = await this.conversationDatabaseService.findOneBy({
        id: conversationId,
      });

      if (conversation && conversation.latestSummaryId !== saved.id) {
        conversation.latestSummaryId = saved.id;

        await this.conversationDatabaseService.save(conversation);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';

      this.logger.warn(
        `Summary job failed for conversation ${conversationId}: ${message}`,
      );
    }
  }
}
