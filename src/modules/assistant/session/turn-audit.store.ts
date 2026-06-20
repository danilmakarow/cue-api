import { Injectable } from '@nestjs/common';

import { ToolRoundAuditPayload } from '../assistant.types';
import {
  ConversationMessageContentType,
  ConversationMessageRole,
} from '@/modules/database/entities';
import { ConversationMessageDatabaseService } from '@/modules/database/services';

/**
 * Max characters of a tool result kept in the persisted audit payload. The full
 * result was already fed to the model live; the audit copy only needs to be
 * diagnostic, so a long agenda / tool dump is capped to bound jsonb row growth.
 */
const MAX_AUDIT_RESULT_CHARS = 2000;

/**
 * L3 session store for the tool-loop audit trail — the forensic `role = tool`
 * rows that record "what did the assistant actually do on this turn". Owns the
 * per-round persistence (and the audit-payload size cap) so the orchestrator
 * delegates rather than touching the message DB service directly. Injects the
 * 3-layer {@link ConversationMessageDatabaseService} (downward L3 → L7).
 */
@Injectable()
export class TurnAuditStore {
  constructor(
    private readonly conversationMessageDatabaseService: ConversationMessageDatabaseService,
  ) {}

  /**
   * Persists the tool-loop audit trail: one `role = tool` message per round,
   * with the structured calls/results in `toolPayload`. These rows are excluded
   * from the verbatim prompt window (DB service), so they are pure forensics —
   * "what did the assistant actually do on this turn" becomes a SQL query. Never
   * bumps `lastActivityAt` (the user/assistant turns bracket the round already).
   *
   * Each turn writes up to `maxToolRoundtrips` rows and these are never pruned —
   * TODO(retention): add a scheduled prune of `role = tool` rows older than N
   * days (the `(conversationId, createdAt)` index + `@nestjs/schedule` exist)
   * before this carries sustained traffic.
   */
  async persistToolRounds(
    conversationId: string,
    rounds: ToolRoundAuditPayload[],
  ): Promise<void> {
    for (const round of rounds) {
      const summary = round.steps
        .map((step) => {
          const status = step.held ? 'held' : step.isError ? 'error' : 'ok';

          return `${step.name}(${status})`;
        })
        .join(', ');

      const boundedSteps = round.steps.map((step) =>
        step.resultContent.length > MAX_AUDIT_RESULT_CHARS
          ? {
              ...step,
              resultContent: `${step.resultContent.slice(0, MAX_AUDIT_RESULT_CHARS)}… [truncated]`,
            }
          : step,
      );

      const message = this.conversationMessageDatabaseService.createInstance({
        conversationId,
        role: ConversationMessageRole.TOOL,
        contentType: ConversationMessageContentType.TOOL_STEP,
        content: `[${round.correlationId}] round ${round.round} ${round.stopReason}: ${
          summary || 'no tools'
        }`,
        toolPayload: { ...round, steps: boundedSteps },
        vendorMessageId: null,
      });

      await this.conversationMessageDatabaseService.save(message);
    }
  }
}
