/**
 * L2 inbound router (taxonomy) — the divergence gate. Promoted from the old
 * `webhook.consumer.routeForUser` command/callback/voice/text branching, it
 * classifies one normalized inbound update into EXACTLY ONE of four flows. The
 * consumer then dispatches: the two no-LLM paths (command, conflict-confirm)
 * keep their existing deterministic handlers; the two model paths (simple
 * message, answer) converge at the turn runner.
 *
 * See `docs/specs/assistant-layered-architecture.md` → "The inbound flow
 * taxonomy (4 flows, one gate)".
 */

import { ConflictCallbackAction } from '../assistant.types';
import { PendingInteractionStore } from '../session/pending-interaction.store';
import { User } from '@/modules/database/entities';
import {
  InboundKind,
  NormalizedInboundMessage,
} from '@/modules/external-vendor/external-vendor.types';

/**
 * Callback-data prefix (with trailing colon) that marks a deterministic
 * conflict-confirm/cancel tap (ADR 0006). Derived from {@link
 * ConflictCallbackAction} so it can never drift from what {@link
 * AssistantService.holdAndAsk} writes onto the inline keyboard.
 */
export const CONFIRM_CALLBACK_PREFIX = `${ConflictCallbackAction.CONFIRM}:`;

/** Callback-data prefix (with trailing colon) for a conflict CANCEL tap. */
export const CANCEL_CALLBACK_PREFIX = `${ConflictCallbackAction.CANCEL}:`;

/**
 * Callback-data prefix (with trailing colon) that marks an `ask_user` answer
 * tap. Disjoint from the conflict prefixes at the wire level so the two
 * suspend/resume paths never collide. The WRITE side (an `ask_user` turn
 * actually emitting buttons with this prefix) lands in Story 5; this wave only
 * recognizes the prefix on the read side, so the `ask:` callback branch is
 * structurally present but unreachable until then.
 */
export const ASK_CALLBACK_PREFIX = 'ask:';

/**
 * A slash command → the deterministic command handler (no LLM). Carries the
 * normalized command name + args verbatim.
 */
export interface CommandFlow {
  kind: 'command';
  command: string;
  args: string[];
}

/**
 * A conflict-confirm/cancel button tap (ADR 0006) → executed deterministically
 * on tap, the model is NEVER re-invoked. The opaque callback id + data ride
 * through to the existing conflict handler unchanged.
 */
export interface ConflictConfirmFlow {
  kind: 'conflict_confirm';
  callbackId: string;
  callbackData: string;
}

/**
 * An answer to a pending `ask_user` question → re-invokes the model (converges
 * at the turn runner). Two sources: an `ask:`-prefixed button tap, or a
 * free-text message while a question is open. `source` records which, and
 * `callbackId`/`callbackData` are present only for the button source (so the
 * resume can acknowledge the callback and parse the chosen option). For this
 * wave the free-text source never fires (no question is ever created) and the
 * button source is unreachable until Story 5 emits `ask:` buttons.
 */
export interface AnswerFlow {
  kind: 'answer';
  source: 'callback' | 'text';
  text: string;
  contentType: InboundKind;
  callbackId: string | null;
  callbackData: string | null;
}

/**
 * Any other text or voice message with no pending question → a fresh turn
 * (converges at the turn runner). Carries the text (a voice transcript is
 * supplied by the consumer after STT) and the originating kind.
 */
export interface SimpleMessageFlow {
  kind: 'simple_message';
  text: string;
  contentType: InboundKind;
}

/**
 * The four mutually-exclusive inbound flows. A discriminated union on `kind` so
 * the consumer's dispatch is exhaustive and the divergence gate is a single
 * `switch`.
 */
export type InboundFlow =
  | CommandFlow
  | ConflictConfirmFlow
  | AnswerFlow
  | SimpleMessageFlow;

/**
 * Classifies one normalized inbound update into exactly one {@link InboundFlow}
 * for the given user. Order matters — it encodes the taxonomy precedence:
 *  1. Command (slash) → CommandFlow (no LLM).
 *  2. Callback whose data starts with `confirm:`/`cancel:` → ConflictConfirmFlow
 *     (ADR 0006, deterministic, NO model).
 *  3. Callback whose data starts with `ask:` → AnswerFlow (button answer).
 *  4. Text/voice AND a pending question exists → AnswerFlow (free-text answer).
 *  5. Otherwise (text/voice, no pending) → SimpleMessageFlow (fresh turn).
 *
 * Voice updates are routed by their transcript: the consumer transcribes first
 * and passes the resulting text, so a voice note is classified exactly like a
 * typed message (simple vs free-text-answer). A callback that matches no known
 * prefix is treated as a simple/answer text fall-through using its raw data —
 * defensive, though every callback the assistant emits carries a known prefix.
 *
 * `pendingQuestionExists()` is a cheap Redis `EXISTS` (step 4 only). For this
 * wave it always resolves false (no question is ever created — Story 5 adds the
 * write side), so AnswerFlow-via-free-text never fires here.
 */
export const classifyFlow = async (
  normalized: NormalizedInboundMessage,
  user: User,
  pendingStore: PendingInteractionStore,
  transcript?: string,
): Promise<InboundFlow> => {
  if (normalized.kind === InboundKind.Command && normalized.command) {
    return {
      kind: 'command',
      command: normalized.command,
      args: normalized.commandArgs ?? [],
    };
  }

  if (normalized.kind === InboundKind.Callback && normalized.callbackId) {
    const callbackData = normalized.callbackData ?? '';

    if (
      callbackData.startsWith(CONFIRM_CALLBACK_PREFIX) ||
      callbackData.startsWith(CANCEL_CALLBACK_PREFIX)
    ) {
      return {
        kind: 'conflict_confirm',
        callbackId: normalized.callbackId,
        callbackData,
      };
    }

    if (callbackData.startsWith(ASK_CALLBACK_PREFIX)) {
      return {
        kind: 'answer',
        source: 'callback',
        text: callbackData,
        contentType: InboundKind.Callback,
        callbackId: normalized.callbackId,
        callbackData,
      };
    }
  }

  // From here on it is a text or (already-transcribed) voice message. A voice
  // note arrives with its transcript supplied; a text note carries `text`.
  const messageText =
    normalized.kind === InboundKind.Voice
      ? (transcript ?? '')
      : (normalized.text ?? '');

  if (await pendingStore.hasPendingQuestion(user.id)) {
    return {
      kind: 'answer',
      source: 'text',
      text: messageText,
      contentType: normalized.kind,
      callbackId: null,
      callbackData: null,
    };
  }

  return {
    kind: 'simple_message',
    text: messageText,
    contentType: normalized.kind,
  };
};
