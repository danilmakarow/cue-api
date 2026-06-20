import { CorrectionReason, ToolRoundAuditPayload } from '../assistant.types';
import { AiStopReason } from '@/modules/ai/ai.types';

/**
 * Corrective USER message appended to the conversation when the model narrates a
 * change but calls no tools (ADR 0009 narration re-drive). It nudges the model
 * to actually call the tools on the next round (issued with `tool_choice:'any'`)
 * or to ask a clarifying question instead. This is a plain user `PromptBlock` —
 * NEVER a synthetic `tool_result` (a `tool_result` with no matching `tool_use`
 * is an Anthropic 400).
 */
export const CORRECTIVE_NUDGE =
  'You said you would make changes but called no tools, so nothing was saved. ' +
  'If you intend to act, call the tools now to actually make the changes; ' +
  'otherwise tell me what you need from me.';

/**
 * Reports whether the narration re-drive budget (ADR 0009) is spent: `true` once
 * the corrections made so far reach the configured ceiling. `maxCorrections === 0`
 * is the kill-switch (budget is immediately exhausted), handled by the caller.
 */
export const isCorrectionBudgetExhausted = (
  corrections: number,
  maxCorrections: number,
): boolean => corrections >= maxCorrections;

/**
 * Builds the audit row for a re-driven narration round (ADR 0009): a terminal
 * turn that produced text but no tool calls, tagged with the diagnostic
 * `correctionReason` so re-drive frequency is greppable. It carries no steps
 * (no tools ran).
 */
export const buildNarrationAuditRound = (
  correlationId: string,
  round: number,
  stopReason: AiStopReason,
  text: string | undefined,
  reason: CorrectionReason,
): ToolRoundAuditPayload => {
  return {
    correlationId,
    round,
    stopReason,
    assistantText: text ?? null,
    steps: [],
    correctionReason: reason,
  };
};
