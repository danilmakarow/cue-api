/**
 * L2 inbound router (taxonomy) — the divergence gate. Promoted from the old
 * `webhook.consumer.routeForUser` command/callback/voice/text branching, it
 * classifies one normalized inbound update into EXACTLY ONE flow. The consumer
 * then dispatches: the no-LLM paths (command, keyboard-action) keep their
 * deterministic handlers; the model paths (simple message, answer) converge at
 * the turn runner. (The ADR-0006 conflict-confirm tap was removed with the
 * deterministic hold — ADR 0011.)
 *
 * See `docs/specs/assistant-layered-architecture.md` → "The inbound flow
 * taxonomy (one gate)".
 */

import {
  KeyboardAction,
  resolveKeyboardAction,
} from '../reply/reply-keyboard.layout';
import { ActiveKeyboardReadPort } from '../session/active-keyboard.store';
import { PendingInteractionStore } from '../session/pending-interaction.store';
import { User } from '@/modules/database/entities';
import {
  InboundKind,
  NormalizedInboundMessage,
} from '@/modules/external-vendor/external-vendor.types';

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
 * A persistent reply-keyboard tap (Story 16 / ADR 0045) → resolved
 * deterministically, the model is NEVER re-invoked. Reply-keyboard taps arrive as
 * PLAIN TEXT equal to the button label (NOT a callback — Verified Telegram facts),
 * so this flow is recognized by text-equality on the label, AND ONLY when the reply
 * keyboard is the ACTIVE SURFACE for the user (a Redis flag of which keyboard is
 * docked) and that surface owns the exact label. That two-part gate — active
 * surface present AND the docked surface owns the label — is what stops a user who
 * literally types "Settings" in normal conversation from being hijacked: with no
 * active keyboard (or a different keyboard docked), the same text is just a
 * {@link SimpleMessageFlow}. `action` is the resolved deterministic action.
 */
export interface KeyboardActionFlow {
  kind: 'keyboard_action';
  action: KeyboardAction;
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
  | KeyboardActionFlow
  | AnswerFlow
  | SimpleMessageFlow;

/**
 * Classifies one normalized inbound update into exactly one {@link InboundFlow}
 * for the given user. Order matters — it encodes the taxonomy precedence:
 *  1. Command (slash) → CommandFlow (no LLM).
 *  2. Callback whose data starts with `ask:` → AnswerFlow (button answer).
 *  3. TYPED text equal to a button label AND the reply keyboard is the active
 *     surface owning that label → KeyboardActionFlow (Story 16, deterministic, NO
 *     model). Gated on the active surface so a user who literally types a label in
 *     normal conversation is NOT hijacked — see the active-surface disambiguation.
 *     This precedes the answer/simple branches because a keyboard tap is plain text
 *     and must be claimed deterministically rather than fed to the model. (A VOICE
 *     transcript is never a keyboard tap — only typed text echoes a label verbatim.)
 *  4. Text/voice AND a pending question exists → AnswerFlow (free-text answer).
 *  5. Otherwise (text/voice, no pending) → SimpleMessageFlow (fresh turn).
 *
 * Voice updates are routed by their transcript: the consumer transcribes first
 * and passes the resulting text, so a voice note is classified exactly like a
 * typed message (simple vs free-text-answer) — but never as a keyboard tap, which
 * only typed text can be. A callback that matches no known prefix is treated as a
 * simple/answer text fall-through using its raw data — defensive, though every
 * callback the assistant emits carries a known prefix. (The ADR-0006
 * `confirm:`/`cancel:` conflict tap was removed with the deterministic hold — ADR
 * 0011.)
 */
export const classifyFlow = async (
  normalized: NormalizedInboundMessage,
  user: User,
  pendingStore: PendingInteractionStore,
  activeKeyboardStore: ActiveKeyboardReadPort,
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

  // A reply-keyboard tap arrives as TYPED text equal to a button label (never a
  // voice transcript). It is a keyboard action ONLY when a keyboard is the active
  // surface for the user AND that surface owns the exact label — the precise gate
  // that prevents hijacking a user who types a label in normal conversation. The
  // active-surface lookup is consulted only for typed text, and short-circuits the
  // simple/answer branches below so the tap is resolved deterministically.
  if (normalized.kind === InboundKind.Text && messageText.length > 0) {
    const surface = await activeKeyboardStore.getActiveSurface(user.id);

    if (surface !== null) {
      const action = resolveKeyboardAction(surface, messageText);

      if (action !== null) {
        return { kind: 'keyboard_action', action };
      }
    }
  }

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
