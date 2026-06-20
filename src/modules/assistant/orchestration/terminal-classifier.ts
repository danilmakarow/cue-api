import { CorrectionReason } from '../assistant.types';
import { AiStopReason } from '@/modules/ai/ai.types';

/** Reply sent when a turn hits the overall tool round-trip ceiling. */
export const ROUNDTRIP_CEILING_REPLY =
  'That took more steps than I can take in one go — could you narrow it down a little?';

/**
 * Reply sent when the model's final, no-tool-call turn stopped on `max_tokens`:
 * the text we hold is a possibly mid-sentence fragment, so we send an honest
 * "I had to cut that short" rather than relay a truncated reply that could read
 * as complete (or, worse, half-confirm an action). The user can ask to continue.
 */
export const TRUNCATED_REPLY =
  "I had to cut that short — ask me to continue and I'll finish.";

/**
 * Reply sent when the model's final turn stopped on `refusal`: the model
 * declined to answer, so we surface an honest, neutral decline instead of
 * relaying whatever partial text (if any) rode along with the refusal.
 */
export const REFUSAL_REPLY =
  "I'm not able to help with that one — try rephrasing, or ask me something else.";

/**
 * Detects the model asserting *its own* calendar mutation (EN + RU). Matches a
 * first-person subject for English ("I created / I've booked / added it"), a
 * present-progressive gerund of a mutation verb ("Creating all seven…",
 * "Adding it now") — the form an LLM tips into when it narrates a batch write
 * and the first-person-past regex would miss — and first-person verb stems for
 * Russian, which drops the pronoun ("Создаю…", "добавил"). A {@link
 * CLAIM_VETO_PATTERN} match always overrides it. Reporting an existing booking
 * ("the cancelled meeting was Friday") is neither first-person nor a gerund and
 * does not match; a benign read summary ("done", "here's your agenda") has no
 * mutation verb and does not match — so legitimate read-only turns never trip it.
 */
export const MUTATION_CLAIM_PATTERN =
  /\bI(?:['’]ve|['’]ll|['’]m| have| just| will| already)?\s+(?:created|added|booked|scheduled|saved|set up|moved|rescheduled|updated|deleted|removed|cancell?ed|put (?:it|that|them))\b|\b(?:created|added|booked|scheduled|moved|saved|updated|rescheduled|deleted|removed|cancell?ed) (?:it|them|that|your)\b|\b(?:creating|adding|booking|scheduling|saving|setting up|moving|rescheduling|updating|deleting|removing|cancell?ing)\b|созда(?:л|ю|м|ла)|добав(?:ил|лю|ляю|ила)|запис(?:ал|ала)|запланир(?:овал|ую)|перенёс|перенесл[аи]?|перенесу|обнов(?:ил|лю)|удал(?:ил|ю|ила)|сохран(?:ил|ю)/iu;

/**
 * Vetoes a mutation "claim" that is actually a non-action: a negation ("nothing
 * was deleted", "I couldn't add"), a report of existing state ("already
 * booked"), or an offer/question ("want me to add?", trailing "?"). When this
 * matches we never override the reply — the model is being honest, or asking.
 */
export const CLAIM_VETO_PATTERN =
  /\b(?:not|n['’]t|nothing|never|already|unable|cannot|can['’]t|couldn['’]t|could not|won['’]t|would not|didn['’]t|don['’]t|no longer|want me to|shall i|should i|would you like)\b|(?:^|[\s,])(?:не|ни|ничего|нельзя|уже|хочешь|хотите)(?=[\s,.!?]|$)|не удалось|не получилось|\?\s*$/iu;

/**
 * The classification of a terminal (no-tool-call) turn (ADR 0009).
 * `genuine` = a real answer / clarifying question / honest failure → send it.
 * `narration_without_write` = the model described a change it never made (zero
 * tool calls, zero commits, not a question) → re-drive it. The trigger is
 * STRUCTURAL; the optional `reason` is a lexical logging hint only.
 */
export type TerminalClassification =
  | { kind: 'genuine' }
  | { kind: 'narration_without_write'; reason: CorrectionReason };

/**
 * Resolves the user-facing text for a terminal (no-tool-call) turn, branching
 * on the stop reason so we never relay an unreliable fragment. MAX_TOKENS means
 * the held text is a truncated cut-off, so we send an honest "cut that short"
 * rather than a reply that could read as complete; REFUSAL means the model
 * declined, so we surface a neutral decline; any other terminal reason relays
 * the model's own text, falling back to the round-trip-ceiling line when it
 * produced none.
 */
export const terminalReplyText = (
  stopReason: AiStopReason,
  text: string | undefined,
): string => {
  if (stopReason === AiStopReason.MAX_TOKENS) {
    return TRUNCATED_REPLY;
  }

  if (stopReason === AiStopReason.REFUSAL) {
    return REFUSAL_REPLY;
  }

  return text ?? ROUNDTRIP_CEILING_REPLY;
};

/**
 * Classifies a terminal (no-tool-call) turn into `genuine` vs
 * `narration_without_write` (ADR 0009). The re-drive trigger is STRUCTURAL:
 * zero committed writes AND not a clarifying question / honest failure (the
 * {@link CLAIM_VETO_PATTERN} hard floor) AND a positive signal that the model
 * *intended* a write but performed none —
 *  - a write WAS attempted but every one errored (`attemptedWrites > 0`), or
 *  - NO write was attempted yet the text narrates a mutation
 *    ({@link MUTATION_CLAIM_PATTERN}, which now also catches the English gerund
 *    "Creating all seven…" the first-person regex missed).
 *
 * Any committed write (incl. a partial batch) is genuine. A non-`END_TURN`
 * terminal (MAX_TOKENS truncation, REFUSAL, etc.) is genuine and gets the
 * honest reply branch — a truncated fragment is not a narration. A pure
 * read-only Q&A turn ("done", "here's your agenda") narrates no mutation and
 * is genuine, so legitimate reads are never forced into a write. This mirrors
 * the {@link isFalseSuccessReply} positive signals exactly: Story 1 RE-DRIVES
 * where the kill-switch path still MASKS.
 */
export const classifyTerminalTurn = (
  stopReason: AiStopReason,
  text: string | undefined,
  committedWrites: number,
  attemptedWrites: number,
): TerminalClassification => {
  if (committedWrites > 0) {
    return { kind: 'genuine' };
  }

  // Only a clean END_TURN can be a narration; a truncation/refusal/other
  // terminal is genuine and gets the honest reply branch, never a re-drive.
  if (stopReason !== AiStopReason.END_TURN) {
    return { kind: 'genuine' };
  }

  const replyText = text ?? '';

  // The veto is the hard floor: a question / negation / honest failure is a
  // genuine terminal and must never be forced to write or re-driven.
  if (CLAIM_VETO_PATTERN.test(replyText)) {
    return { kind: 'genuine' };
  }

  // A write was attempted but every one failed: re-drive so the model can
  // retry the action rather than relay a success-sounding line.
  if (attemptedWrites > 0) {
    return {
      kind: 'narration_without_write',
      reason: 'writes_errored',
    };
  }

  // No write attempted: re-drive only when the text actually narrates a
  // mutation. A benign read summary trips neither pattern and stays genuine.
  if (MUTATION_CLAIM_PATTERN.test(replyText)) {
    return {
      kind: 'narration_without_write',
      reason: 'claim_without_writes',
    };
  }

  return { kind: 'genuine' };
};
