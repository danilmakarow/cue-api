import {
  CLAIM_VETO_PATTERN,
  MUTATION_CLAIM_PATTERN,
} from './terminal-classifier';

/**
 * The committed/attempted write delta a single dispatched tool contributes to
 * the turn's write ledger. A batch tool supplies its own counts; a single-write
 * tool omits them and falls back to the exact per-call +1 (one attempt; one
 * commit unless it errored).
 */
export interface WriteLedgerDelta {
  attempted: number;
  committed: number;
}

/**
 * Computes the write-ledger delta for one dispatched WRITE tool. A batch tool
 * supplies its own committed/attempted counts; a single-write tool omits them,
 * so fall back to the exact per-call +1 — one attempt, and one commit unless it
 * errored. Callers add the returned deltas onto the running turn totals.
 */
export const writeLedgerDelta = (
  attemptedCount: number | undefined,
  committedCount: number | undefined,
  isError: boolean,
): WriteLedgerDelta => {
  return {
    attempted: attemptedCount ?? 1,
    committed: committedCount ?? (isError ? 0 : 1),
  };
};

/**
 * Decides whether a reply falsely claims success and must be replaced (failure
 * mode #1). Fires only when nothing committed, and never over an honest or
 * read-only reply (the veto). Two confident signals:
 *  - a write WAS attempted but none committed → it failed; unless the reply
 *    already admits that (veto), the success-sounding text is wrong; or
 *  - NO write was attempted at all, yet the reply asserts a mutation (the
 *    pure-narration trap, e.g. "Создаю все семь" with zero tool calls).
 * A read-only Q&A turn (no write attempted, no mutation claim) never fires.
 * Single source of the patterns ({@link CLAIM_VETO_PATTERN} /
 * {@link MUTATION_CLAIM_PATTERN}); the orchestrator's post-loop guard and the
 * loop's terminal classifier both flow through here.
 */
export const isFalseSuccessReply = (
  text: string,
  committedWrites: number,
  attemptedWrites: number,
): boolean => {
  if (committedWrites > 0) {
    return false;
  }

  if (CLAIM_VETO_PATTERN.test(text)) {
    return false;
  }

  if (attemptedWrites > 0) {
    return true;
  }

  return MUTATION_CLAIM_PATTERN.test(text);
};
