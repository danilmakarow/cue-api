import { Inject, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';

import { AssistantConfig } from '../assistant.config';
import { MEMORY_EXTRACTION_SYSTEM_PROMPT } from '../assistant.prompts';
import { AiConnector } from '@/modules/ai/ai-connector.abstract';
import { ACTIVE_AI_CONNECTOR } from '@/modules/ai/ai.module';
import { AiModelRole, PromptRole } from '@/modules/ai/ai.types';
import {
  ConversationMessage,
  UserMemoryFactSource,
  UserMemoryFactType,
} from '@/modules/database/entities';
import {
  ConversationMessageDatabaseService,
  UserMemoryFactDatabaseService,
} from '@/modules/database/services';

/** How many recent messages the extractor scans for durable facts. */
const EXTRACTION_WINDOW = 12;

/**
 * One durable fact the background model may extract. `conflict_policy` is
 * explicitly EXCLUDED (Story 15 / ADR 0011 + 0044): a standing double-booking
 * policy must NEVER be inferred — only a user-set EXPLICIT fact counts as
 * standing authorization — so the extractor cannot emit one even if the model
 * tries. The refinement drops it as an invalid type rather than persisting an
 * inferred policy that could silently widen the conflict gate.
 */
const extractedFactSchema = z.object({
  type: z
    .nativeEnum(UserMemoryFactType)
    .refine((type) => type !== UserMemoryFactType.CONFLICT_POLICY, {
      message: 'conflict_policy is user-set only and can never be inferred.',
    }),
  key: z.string().min(1),
  value: z.object({}).catchall(z.unknown()),
  confidence: z.number().min(0).max(1),
});

/** Structured shape the background model returns for extracted facts. */
const extractionResultSchema = z.object({
  facts: z.array(extractedFactSchema),
});

/** A single extracted fact, derived from its Zod schema. */
type ExtractedFact = z.infer<typeof extractedFactSchema>;

/**
 * Extracts durable, typed facts about the user from recent turns into
 * `UserMemoryFact` (ADR 0005 tier 3) on the cheap BACKGROUND model. Runs after a
 * reply, off the request path. New facts are upserted by their natural key so a
 * later run refines rather than duplicates; explicit (user-stated) facts are
 * never overwritten by an inferred one.
 */
@Injectable()
export class MemoryExtractorService {
  private readonly logger = new Logger(MemoryExtractorService.name);

  constructor(
    @Inject(ACTIVE_AI_CONNECTOR) private readonly ai: AiConnector,
    private readonly config: AssistantConfig,
    private readonly conversationMessageDatabaseService: ConversationMessageDatabaseService,
    private readonly userMemoryFactDatabaseService: UserMemoryFactDatabaseService,
  ) {}

  /**
   * Renders the messages scanned for facts into a compact transcript.
   */
  private static renderTranscript(messages: ConversationMessage[]): string {
    return messages
      .map((message) => `${message.role}: ${message.content}`)
      .join('\n');
  }

  /**
   * Persists one extracted fact: refreshes an existing fact with the same
   * natural key (unless it is user-explicit), or creates a new inferred one.
   */
  private async upsertFact(userId: string, fact: ExtractedFact): Promise<void> {
    const existing = await this.userMemoryFactDatabaseService.findByNaturalKey(
      userId,
      fact.type,
      fact.key,
    );

    if (!existing) {
      const created = this.userMemoryFactDatabaseService.createInstance({
        userId,
        type: fact.type,
        key: fact.key,
        value: fact.value as Record<string, unknown>,
        confidence: fact.confidence,
        source: UserMemoryFactSource.INFERRED,
      });

      await this.userMemoryFactDatabaseService.save(created);

      return;
    }

    if (existing.source === UserMemoryFactSource.EXPLICIT) {
      return;
    }

    existing.value = fact.value as Record<string, unknown>;
    existing.confidence = fact.confidence;

    await this.userMemoryFactDatabaseService.save(existing);
  }

  /**
   * Extracts and upserts durable facts from the conversation's recent turns.
   * Failures are logged and swallowed — a missed extraction never breaks the
   * user-facing turn.
   */
  async extract(conversationId: string, userId: string): Promise<void> {
    try {
      const messages =
        await this.conversationMessageDatabaseService.findRecentWindow(
          conversationId,
          EXTRACTION_WINDOW,
        );

      if (messages.length === 0) {
        return;
      }

      const result = await this.ai.completeStructured(
        {
          modelRole: AiModelRole.BACKGROUND,
          system: [
            { role: PromptRole.USER, content: MEMORY_EXTRACTION_SYSTEM_PROMPT },
          ],
          messages: [
            {
              role: PromptRole.USER,
              content: MemoryExtractorService.renderTranscript(messages),
            },
          ],
        },
        extractionResultSchema,
      );

      for (const fact of result.facts) {
        await this.upsertFact(userId, fact);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';

      this.logger.warn(
        `Memory extraction failed for conversation ${conversationId}: ${message}`,
      );
    }
  }
}
