import { ToolRoundAuditPayload, ToolStepRecord } from '../assistant.types';
import { WRITE_TOOLS } from '../tools/tool-registry';

/**
 * The programmatic reply sent when the user STOPs a turn that had not yet
 * committed any write (Story 14b / ADR 0043). Honest: we stopped, and nothing
 * was changed — distinct from the kept-writes summary below.
 */
const STOP_NOTHING_DONE_REPLY = 'Stopped — nothing was changed.';

/**
 * Maps a committed write step to a short human-readable phrase for the STOP
 * summary, derived purely from the tool name + its input (NO AI call). Falls back
 * to a generic verb so an unrecognized write still reads sensibly.
 */
const describeWriteStep = (step: ToolStepRecord): string => {
  const title =
    typeof step.input.title === 'string' ? `"${step.input.title}"` : null;

  if (step.name === 'create_task') {
    return title ? `created ${title}` : 'created an event';
  }

  if (step.name === 'create_tasks') {
    return 'created several events';
  }

  if (step.name === 'update_task') {
    return title ? `updated ${title}` : 'updated an event';
  }

  if (step.name === 'complete_task') {
    return title ? `completed ${title}` : 'marked an event done';
  }

  if (step.name === 'delete_task') {
    return title ? `deleted ${title}` : 'deleted an event';
  }

  if (step.name === 'create_group') {
    return title ? `created the group ${title}` : 'created a group';
  }

  return 'made a change';
};

/**
 * Builds the STOP reply text programmatically from the per-round audit ledger
 * (Story 14b / ADR 0043) — NO AI call. Scans every round's steps for COMMITTED
 * writes (a write tool whose step did not error and was not held for confirmation)
 * and lists what was done in arrival order before the user stopped. When nothing
 * committed, returns an honest "nothing was changed" line. `committedWrites` is the
 * loop's own counter, used only to keep the wording consistent when the ledger and
 * the counter disagree (the ledger is the source of the human list).
 */
export const buildStopSummary = (
  rounds: ToolRoundAuditPayload[],
  committedWrites: number,
): string => {
  const committedSteps: ToolStepRecord[] = [];

  for (const round of rounds) {
    for (const step of round.steps) {
      if (WRITE_TOOLS.has(step.name) && !step.isError && !step.held) {
        committedSteps.push(step);
      }
    }
  }

  if (committedSteps.length === 0 || committedWrites === 0) {
    return STOP_NOTHING_DONE_REPLY;
  }

  const phrases = committedSteps.map(describeWriteStep);

  return `Stopped. Before stopping I ${joinPhrases(phrases)}.`;
};

/**
 * Joins the committed-write phrases into a natural-reading list: "a", "a and b",
 * or "a, b and c". Pure string formatting for the STOP summary.
 */
const joinPhrases = (phrases: string[]): string => {
  if (phrases.length === 1) {
    return phrases[0];
  }

  const head = phrases.slice(0, -1).join(', ');
  const tail = phrases[phrases.length - 1];

  return `${head} and ${tail}`;
};
