import { Injectable } from '@nestjs/common';

import { AssistantService } from '../assistant.service';
import {
  ConversationMessageContentType,
  User,
} from '@/modules/database/entities';
import { InboundKind } from '@/modules/external-vendor/external-vendor.types';

/**
 * Where a turn's input originated, recorded on {@link TurnState} so the single
 * convergence point can tell a fresh simple message from an answer to a pending
 * `ask_user` question. Both seeds drive the identical loop; this only annotates
 * the seam (the divergence the spec calls out). The `answer` origins are the
 * structural home for Story 5's resume — for this wave they are reachable only
 * via the (always-false today) free-text answer gate and the (Story-5-only)
 * `ask:` button.
 */
export type TurnOrigin = 'simple_message' | 'answer_text' | 'answer_callback';

/**
 * The seed handed to {@link TurnRunnerService.runTurn} — the SINGLE convergence
 * point both the simple-message flow and the answer flow reach. It carries the
 * resolved user, the (already-transcribed, for voice) input text, how that text
 * should be persisted, the vendor chat to reply into, and the correlation id
 * threaded from the webhook. `origin` records which flow seeded it.
 *
 * A `simple_message` origin drives a fresh `handleText` turn; an `answer_*`
 * origin drives the `ask_user` resume (ADR 0010) — `resumeAnswer` claims the
 * pending question and re-enters the loop with the human answer fed back as the
 * suspended `ask_user` `tool_result`. `callbackId` is present only for a button
 * answer (acknowledged + the row id parsed from the `ask:` callback data).
 */
export interface TurnState {
  user: User;
  text: string;
  contentType: ConversationMessageContentType;
  vendorChatId: string;
  vendorMessageId: string | null;
  correlationId: string;
  origin: TurnOrigin;
  /** The callback id to acknowledge for a button answer; null otherwise. */
  callbackId: string | null;
}

/**
 * Maps a normalized inbound kind to how its content is persisted: a voice note's
 * transcript is tagged `VOICE_TRANSCRIPT`, everything else `TEXT`. (A callback
 * answer is persisted as plain text — it is the user's chosen option label.)
 */
const contentTypeFor = (kind: InboundKind): ConversationMessageContentType =>
  kind === InboundKind.Voice
    ? ConversationMessageContentType.VOICE_TRANSCRIPT
    : ConversationMessageContentType.TEXT;

/**
 * L3 turn runner — the single convergence point for every model-driven turn.
 * Both `SimpleMessageFlow` (fresh) and `AnswerFlow` (answer to a pending
 * `ask_user` question) are seeded into a {@link TurnState} and run here, so the
 * consumer owns no second copy of the dispatch. The two no-LLM paths (command,
 * conflict-confirm) bypass this entirely and keep their existing deterministic
 * handlers.
 *
 * `runTurn` is the divergence: a `simple_message` origin runs a fresh
 * {@link AssistantService.handleText}; an `answer_*` origin runs the `ask_user`
 * resume ({@link AssistantService.resumeAnswer}, ADR 0010), which claims the
 * pending question and re-enters the loop with the human answer fed back as the
 * suspended `ask_user` `tool_result`.
 */
@Injectable()
export class TurnRunnerService {
  constructor(private readonly assistant: AssistantService) {}

  /**
   * Builds a {@link TurnState} from a simple/answer message and runs the turn.
   * The `contentType` is derived from the originating kind so a voice transcript
   * persists correctly; `vendorMessageId` is null for inbound text/voice (no
   * outbound ref yet) and for a callback answer. `callbackId` rides through for a
   * button answer so the resume can acknowledge it.
   */
  async runFromMessage(params: {
    user: User;
    text: string;
    kind: InboundKind;
    vendorChatId: string;
    correlationId: string;
    origin: TurnOrigin;
    callbackId?: string | null;
  }): Promise<void> {
    const state: TurnState = {
      user: params.user,
      text: params.text,
      contentType: contentTypeFor(params.kind),
      vendorChatId: params.vendorChatId,
      vendorMessageId: null,
      correlationId: params.correlationId,
      origin: params.origin,
      callbackId: params.callbackId ?? null,
    };

    await this.runTurn(state);
  }

  /**
   * The convergence point: branches on the seeded {@link TurnState} origin. A
   * fresh simple message delegates to the orchestrator's `handleText`; an
   * `answer_callback` / `answer_text` origin delegates to `resumeAnswer`, which
   * claims the pending `ask_user` question and re-invokes the model with the
   * answer. The simple-message delegation is behaviour-preserving — it forwards
   * the exact `HandleTextParams` the consumer used to build inline.
   */
  async runTurn(state: TurnState): Promise<void> {
    if (state.origin === 'simple_message') {
      await this.assistant.handleText(state.user, {
        text: state.text,
        contentType: state.contentType,
        vendorChatId: state.vendorChatId,
        vendorMessageId: state.vendorMessageId,
        correlationId: state.correlationId,
      });

      return;
    }

    await this.assistant.resumeAnswer(state.user, {
      source: state.origin === 'answer_callback' ? 'callback' : 'text',
      text: state.text,
      contentType: state.contentType,
      vendorChatId: state.vendorChatId,
      callbackId: state.callbackId,
      correlationId: state.correlationId,
    });
  }
}
