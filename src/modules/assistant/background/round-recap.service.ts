import { Inject, Injectable, Logger } from '@nestjs/common';

import { ROUND_RECAP_SYSTEM_PROMPT } from '../assistant.prompts';
import { ToolStepRecord } from '../assistant.types';
import { AiConnector } from '@/modules/ai/ai-connector.abstract';
import { ACTIVE_AI_CONNECTOR } from '@/modules/ai/ai.module';
import { AiModelRole, PromptRole } from '@/modules/ai/ai.types';

/** Hard cap on a rendered recap so a runaway background reply can't bloat the draft. */
const MAX_RECAP_CHARS = 120;

/** Output-token ceiling for a recap — one short sentence needs very few. */
const RECAP_MAX_TOKENS = 32;

/**
 * L11 background helper (Story 13 / ADR 0041) that turns one just-completed tool
 * round into a single present-tense progress recap ("Checking Thursday
 * afternoon") for the live status draft, using the cheap BACKGROUND (Haiku)
 * model — the SAME model role the summarizer / memory-extractor use, resolved via
 * config (no hardcoded model id).
 *
 * **Degrade-never-throw.** The recap is a best-effort progress hint, never the
 * answer: any model/parse fault (or an empty round) returns `null` and the caller
 * simply leaves the current status frame. It NEVER throws into the turn (the
 * webhook queue is `attempts:1`).
 */
@Injectable()
export class RoundRecapService {
  private readonly logger = new Logger(RoundRecapService.name);

  constructor(@Inject(ACTIVE_AI_CONNECTOR) private readonly ai: AiConnector) {}

  /**
   * Renders a round's dispatched steps into a compact, model-readable line so the
   * background model can describe "what just happened" without seeing raw JSON
   * payloads. Held/errored steps are flagged so a recap can stay honest.
   */
  private static renderSteps(steps: ToolStepRecord[]): string {
    return steps
      .map((step) => {
        const status = step.held ? ' (held)' : step.isError ? ' (failed)' : '';

        return `${step.name}${status}: ${step.resultContent}`;
      })
      .join('\n');
  }

  /**
   * Generates a one-sentence recap for a just-completed tool round, or `null`
   * when there is nothing to narrate or the background model fails. Trims and caps
   * the output so a verbose model reply can't overflow the draft. Best-effort: a
   * fault is logged at debug and swallowed (returns `null`).
   */
  async recapRound(
    steps: ToolStepRecord[],
    correlationId: string,
  ): Promise<string | null> {
    if (steps.length === 0) {
      return null;
    }

    try {
      const result = await this.ai.complete({
        modelRole: AiModelRole.BACKGROUND,
        system: [{ role: PromptRole.USER, content: ROUND_RECAP_SYSTEM_PROMPT }],
        messages: [
          {
            role: PromptRole.USER,
            content: `Just completed:\n${RoundRecapService.renderSteps(steps)}`,
          },
        ],
        maxTokens: RECAP_MAX_TOKENS,
        traceId: correlationId,
      });

      const recap = result.text?.trim();

      if (!recap) {
        return null;
      }

      return recap.slice(0, MAX_RECAP_CHARS);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';

      this.logger.debug(
        `[cid=${correlationId}] Round recap degraded (background model fault): ${message}`,
      );

      return null;
    }
  }
}
