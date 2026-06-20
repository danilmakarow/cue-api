import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';

import { ConversationStore } from './conversation.store';
import { PendingInteractionService } from './pending-interaction.store';
import { TurnAuditStore } from './turn-audit.store';
import {
  HeldConflictBatch,
  HeldConflictWrite,
  ToolRoundAuditPayload,
} from '../assistant.types';
import { MemoryExtractorService } from '../background/memory-extractor.service';
import { SummarizerService } from '../background/summarizer.service';
import { HeldConflictStore } from '../conflict/held-conflict.store';
import { ASK_CALLBACK_PREFIX } from '../ingress/inbound-router';
import {
  AskSuspension,
  ToolLoopResult,
  ToolLoopService,
} from '../orchestration/tool-loop.service';
import { ReplyPresenter } from '../reply/reply-presenter.service';
import { ToolName } from '../tools/tool-schemas';
import { ToolRound, ToolResultBlock } from '@/modules/ai/ai.types';
import { AlertConnector } from '@/modules/alert/alert-connector.abstract';
import { ACTIVE_ALERT_CONNECTOR } from '@/modules/alert/alert.module';
import { AlertSeverity } from '@/modules/alert/alert.types';
import {
  Conversation,
  ConversationMessageContentType,
  ConversationMessageRole,
  PendingQuestion,
  User,
} from '@/modules/database/entities';
import { InboundKind } from '@/modules/external-vendor/external-vendor.types';

/** Reply sent when the AI fails after its bounded retries (spec error table). */
const AI_FAILURE_REPLY =
  "I'm having trouble reaching my reasoning just now — try again in a moment.";

/**
 * Reply sent in place of a success-sounding message when the model claimed to
 * have changed the calendar but no write tool actually committed this turn
 * (failure mode #1 — narration without tools / all writes failed). We refuse to
 * confirm an action that never happened.
 */
const CLAIM_WITHOUT_WRITE_REPLY =
  "Hmm — I don't think that actually saved. Nothing was changed on my side. Could you try again?";

/**
 * Honest reply sent when the narration re-drive budget is exhausted (ADR 0009
 * `unresolved` outcome): we could not get the model to commit the action, so we
 * say so plainly rather than claim success or stay silent. Never thrown — the
 * BullMQ queue is `attempts:1`, so the turn must always answer.
 */
const CORRECTION_EXHAUSTED_REPLY =
  "I wasn't able to make those changes just now — nothing was saved. Could you try again, perhaps one at a time?";

/**
 * Structured alert-event name fired when the narration re-drive budget is
 * exhausted (ADR 0009). Stable + greppable so the escalation rate is countable
 * regardless of the alert sink.
 */
const CORRECTION_EXHAUSTED_EVENT = 'assistant.correction_exhausted';

/**
 * Parameters for handling a normalized text or voice-transcript turn.
 */
export interface HandleTextParams {
  text: string;
  contentType: ConversationMessageContentType;
  vendorChatId: string;
  vendorMessageId: string | null;
  /** Correlation id threaded from the webhook; minted here if absent. */
  correlationId?: string;
}

/**
 * Parameters for resuming a suspended `ask_user` turn (ADR 0010) with the user's
 * answer. `source` records how the answer arrived: a `callback` carries the
 * `ask:<pendingQuestionId>:<optId>` data (+ the callback id to acknowledge), a
 * `text` carries the raw free-text/transcript answer (resolved against the hot
 * Redis window). Exactly one synthetic `tool_result` is fed back and the loop is
 * re-entered (the model may suspend again).
 */
export interface ResumeAnswerParams {
  source: 'callback' | 'text';
  /** The raw inbound text: the callback data for a button, the message for text. */
  text: string;
  contentType: ConversationMessageContentType;
  vendorChatId: string;
  /** Present (and acknowledged) only for the button source. */
  callbackId: string | null;
  /** Correlation id threaded from the webhook; minted here if absent. */
  correlationId?: string;
}

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
 * L3 turn runner — the single convergence point for every model-driven turn, and
 * (since Story 8 / ADR 0036) the real OWNER of the turn lifecycle. Both
 * `SimpleMessageFlow` (fresh) and `AnswerFlow` (answer to a pending `ask_user`
 * question) are seeded into a {@link TurnState} and run here: it persists the
 * turn (via {@link ConversationStore} / {@link TurnAuditStore}), drives the
 * bounded tool-use loop ({@link ToolLoopService}), presents the reply via the L9
 * {@link ReplyPresenter}, holds conflicting writes (ADR 0006), suspends/resumes
 * `ask_user` (ADR 0010), and fires the post-turn background jobs. The two no-LLM
 * paths (command, conflict-confirm) bypass this entirely and keep their existing
 * deterministic handlers on {@link AssistantService}.
 *
 * `runTurn` is the divergence: a `simple_message` origin runs a fresh
 * {@link handleText}; an `answer_*` origin runs the `ask_user` resume
 * ({@link resumeAnswer}, ADR 0010), which claims the pending question and
 * re-enters the loop with the human answer fed back as the suspended `ask_user`
 * `tool_result`.
 */
@Injectable()
export class TurnRunnerService {
  private readonly logger = new Logger(TurnRunnerService.name);

  constructor(
    @Inject(ACTIVE_ALERT_CONNECTOR) private readonly alert: AlertConnector,
    private readonly toolLoop: ToolLoopService,
    private readonly summarizer: SummarizerService,
    private readonly memoryExtractor: MemoryExtractorService,
    private readonly conversationStore: ConversationStore,
    private readonly turnAuditStore: TurnAuditStore,
    private readonly pendingInteraction: PendingInteractionService,
    private readonly replyPresenter: ReplyPresenter,
    private readonly heldConflictStore: HeldConflictStore,
  ) {}

  /**
   * Returns the user's perpetual conversation, creating it on first contact.
   * Delegates to the L3 {@link ConversationStore}.
   */
  private async getOrCreateConversation(userId: string): Promise<Conversation> {
    return this.conversationStore.getOrCreate(userId);
  }

  /**
   * Persists one conversation message and stamps the conversation's
   * last-activity time. Delegates to the L3 {@link ConversationStore}.
   */
  private async persistMessage(
    conversation: Conversation,
    role: ConversationMessageRole,
    contentType: ConversationMessageContentType,
    content: string,
    vendorMessageId: string | null,
  ): Promise<void> {
    return this.conversationStore.persistMessage(
      conversation,
      role,
      contentType,
      content,
      vendorMessageId,
    );
  }

  /**
   * Persists the tool-loop audit trail (one `role = tool` row per round).
   * Delegates to the L3 {@link TurnAuditStore}.
   */
  private async persistToolRounds(
    conversationId: string,
    rounds: ToolRoundAuditPayload[],
  ): Promise<void> {
    return this.turnAuditStore.persistToolRounds(conversationId, rounds);
  }

  /**
   * Holds a conflicting write in Redis (short TTL) and asks the user to resolve
   * it via an inline keyboard — the model is never re-invoked (ADR 0006 layer
   * 4). The user's button tap later resumes or cancels the held action.
   */
  private async holdAndAsk(
    conversation: Conversation,
    vendorChatId: string,
    held: HeldConflictWrite[],
    promptText: string,
  ): Promise<void> {
    const token = randomUUID();
    const batch: HeldConflictBatch = {
      userId: held[0].userId,
      vendorChatId,
      actions: held.map((conflict) => conflict.action),
    };

    await this.heldConflictStore.stash(token, batch);

    await this.replyPresenter.sendHeldKeyboard(
      vendorChatId,
      promptText,
      held.length,
      token,
    );

    await this.persistMessage(
      conversation,
      ConversationMessageRole.ASSISTANT,
      ConversationMessageContentType.TEXT,
      promptText,
      null,
    );
  }

  /**
   * Suspends an `ask_user` turn (ADR 0010): persists the durable
   * `pending_question` row (carrying the in-flight session) + its Redis hot
   * mirror via {@link PendingInteractionService}, sends the question (plain text
   * when no options, else an inline keyboard whose callback data is
   * `ask:<rowId>:<optId>`), and persists the question as the assistant reply so
   * it survives in the conversation. The turn ENDS here — the model is never
   * re-invoked; the user's later answer drives the resume. Never throws (the
   * BullMQ queue is attempts:1) beyond what the send/persist helpers already
   * swallow.
   */
  private async suspendAndAsk(
    user: User,
    conversation: Conversation,
    vendorChatId: string,
    suspension: AskSuspension,
    correlationId: string,
  ): Promise<void> {
    const pending = await this.pendingInteraction.createPendingQuestion(
      user.id,
      {
        conversationId: conversation.id,
        askToolUseId: suspension.askToolUseId,
        payload: {
          toolRounds: suspension.toolRounds,
          question: suspension.question,
          optionLabels: suspension.optionLabels,
          correlationId,
          vendorChatId,
        },
      },
    );

    const vendorMessageId = await this.replyPresenter.sendQuestion(
      vendorChatId,
      suspension.question,
      suspension.optionLabels,
      pending.id,
      correlationId,
    );

    await this.persistMessage(
      conversation,
      ConversationMessageRole.ASSISTANT,
      ConversationMessageContentType.TEXT,
      suspension.question,
      vendorMessageId,
    );

    this.logger.log(
      `[cid=${correlationId}] Suspended ask_user (pending ${pending.id}, ${suspension.optionLabels.length} options) for user ${user.id}`,
    );
  }

  /**
   * Fires the post-turn background jobs (rolling summary + memory extraction)
   * without blocking the reply (ADR 0005). Each job catches its own errors.
   */
  private triggerBackgroundJobs(conversationId: string, userId: string): void {
    void this.summarizer.maybeSummarize(conversationId);
    void this.memoryExtractor.extract(conversationId, userId);
  }

  /**
   * Handles a text or voice-transcript turn end to end: persist the user turn,
   * build context, run the tool loop, then reply / hold / report a graceful
   * failure, and (on a completed reply) fire the background jobs.
   */
  async handleText(user: User, params: HandleTextParams): Promise<void> {
    const correlationId = params.correlationId ?? randomUUID();
    const conversation = await this.getOrCreateConversation(user.id);

    await this.persistMessage(
      conversation,
      ConversationMessageRole.USER,
      params.contentType,
      params.text,
      params.vendorMessageId,
    );

    const result = await this.toolLoop.run({
      user,
      conversationId: conversation.id,
      currentMessageText: params.text,
      correlationId,
    });

    await this.finishTurn(
      user,
      conversation,
      params.vendorChatId,
      result,
      correlationId,
    );
  }

  /**
   * The shared post-loop tail (ADR 0006/0009/0010): persists the audit trail,
   * then branches on the {@link LoopOutcome} — `held` parks + asks via inline
   * keyboard, `ask` suspends the turn (ADR 0010), `error` sends the AI-failure
   * line, `unresolved` escalates honestly (alert + reply), and a plain reply runs
   * the false-success guard before sending + persisting and firing the background
   * jobs. Single-sourced so a fresh turn ({@link handleText}) and an `ask_user`
   * resume ({@link resumeAnswer}) end identically — including the ability to
   * suspend AGAIN when the resumed model asks a follow-up question. Never throws
   * (attempts:1); every helper it calls swallows its own send/persist failure.
   */
  private async finishTurn(
    user: User,
    conversation: Conversation,
    vendorChatId: string,
    result: ToolLoopResult,
    correlationId: string,
  ): Promise<void> {
    const { outcome, rounds, committedWrites, attemptedWrites } = result;

    // Persist the tool-loop audit trail regardless of how the turn ended.
    await this.persistToolRounds(conversation.id, rounds);

    if (outcome.kind === 'held') {
      await this.holdAndAsk(
        conversation,
        vendorChatId,
        outcome.held,
        outcome.promptText,
      );

      return;
    }

    if (outcome.kind === 'ask') {
      await this.suspendAndAsk(
        user,
        conversation,
        vendorChatId,
        outcome.suspension,
        correlationId,
      );

      return;
    }

    if (outcome.kind === 'error') {
      await this.replyPresenter.sendText(
        vendorChatId,
        AI_FAILURE_REPLY,
        correlationId,
      );

      return;
    }

    // Narration re-drive exhausted (ADR 0009): the model never committed the
    // action it claimed within the correction budget. Escalate via the alert
    // sink (structured event) AND send an honest reply. This MUST NOT throw —
    // the BullMQ queue is attempts:1, so a throw would lose the turn silently.
    if (outcome.kind === 'unresolved') {
      this.alert.capture({
        name: CORRECTION_EXHAUSTED_EVENT,
        severity: AlertSeverity.ERROR,
        message:
          'Narration re-drive budget exhausted; the model never committed the claimed action.',
        context: {
          correlationId,
          userId: user.id,
          corrections: outcome.corrections,
          attemptedWrites,
          committedWrites,
        },
      });

      const vendorMessageId = await this.replyPresenter.sendText(
        vendorChatId,
        CORRECTION_EXHAUSTED_REPLY,
        correlationId,
      );

      await this.persistMessage(
        conversation,
        ConversationMessageRole.ASSISTANT,
        ConversationMessageContentType.TEXT,
        CORRECTION_EXHAUSTED_REPLY,
        vendorMessageId,
      );

      return;
    }

    // Guard (failure mode #1): the reply sounds like success but nothing actually
    // committed — refuse to confirm an action that never happened, and flag it.
    // This is now defence-in-depth: with re-drive enabled the loop already
    // re-drove a narration turn, so this fires mainly under the kill-switch
    // (ASSISTANT_MAX_CORRECTIONS=0), restoring today's detect-and-mask behaviour.
    let replyText = outcome.text;

    if (
      this.toolLoop.isFalseSuccessReply(
        replyText,
        committedWrites,
        attemptedWrites,
      )
    ) {
      this.logger.warn(
        `[cid=${correlationId}] Reply implies success but 0 writes committed ` +
          `(attempted=${attemptedWrites}) for user ${user.id}; sending a ` +
          `corrected reply. Original: ${JSON.stringify(replyText.slice(0, 200))}`,
      );
      replyText = CLAIM_WITHOUT_WRITE_REPLY;
    }

    const vendorMessageId = await this.replyPresenter.sendText(
      vendorChatId,
      replyText,
      correlationId,
    );

    await this.persistMessage(
      conversation,
      ConversationMessageRole.ASSISTANT,
      ConversationMessageContentType.TEXT,
      replyText,
      vendorMessageId,
    );

    this.triggerBackgroundJobs(conversation.id, user.id);
  }

  /**
   * Resumes a suspended `ask_user` turn (ADR 0010) with the user's answer — the
   * one path that DOES re-invoke the model (distinct from the deterministic
   * conflict callback). It acknowledges a button tap, atomically claims the
   * pending question (a button claims its row by id even after the Redis TTL /a
   * restart; free text claims the user's hot window), maps the answer to a label,
   * appends EXACTLY ONE synthetic `ask_user` `tool_result` paired to the suspended
   * `askToolUseId`, and re-enters the tool loop with the rehydrated rounds so the
   * model continues (it may ask again). A null claim means the question was
   * already answered (a double-answer race) or the hot window lapsed for a
   * free-text reply — ignored gracefully so the turn is never double-resumed.
   */
  async resumeAnswer(user: User, params: ResumeAnswerParams): Promise<void> {
    const correlationId = params.correlationId ?? randomUUID();

    if (params.source === 'callback' && params.callbackId) {
      await this.replyPresenter.acknowledgeCallback(params.callbackId);
    }

    const claim = await this.claimPending(user, params, correlationId);

    if (!claim) {
      // Already answered (race / superseded) or the hot window lapsed for a
      // free-text reply. A button after the window still claims from Postgres
      // above; a lapsed free-text answer falls through to nothing here (the
      // router would have routed it as a fresh turn anyway).
      this.logger.log(
        `[cid=${correlationId}] No claimable pending question for user ${user.id} (${params.source}); ignoring.`,
      );

      return;
    }

    const conversation = await this.getOrCreateConversation(user.id);

    // Persist the user's answer as their turn so the thread reads naturally (the
    // chosen option's label, or the raw free text).
    await this.persistMessage(
      conversation,
      ConversationMessageRole.USER,
      params.contentType,
      claim.answerLabel,
      null,
    );

    const resumedRounds = this.appendSyntheticAnswer(
      claim.pending,
      claim.answerLabel,
    );
    const result = await this.toolLoop.run({
      user,
      conversationId: conversation.id,
      currentMessageText: '',
      correlationId,
      resumeRounds: resumedRounds,
    });

    await this.finishTurn(
      user,
      conversation,
      params.vendorChatId,
      result,
      correlationId,
    );
  }

  /**
   * Atomically claims the pending question for a resume and resolves the answer's
   * human label. A button parses `ask:<pendingQuestionId>:<optId>` and claims that
   * row by id (durable, works after the Redis TTL), mapping `optId → label` from
   * the stored option map (falling back to the raw id if the option vanished); a
   * free-text answer claims the user's hot window and uses the raw text as the
   * label. Returns null when nothing was claimable (already answered / window
   * lapsed). Never re-invokes the model.
   */
  private async claimPending(
    user: User,
    params: ResumeAnswerParams,
    correlationId: string,
  ): Promise<{ pending: PendingQuestion; answerLabel: string } | null> {
    if (params.source === 'callback') {
      const { pendingQuestionId, optionId } = this.parseAskCallback(
        params.text,
      );

      if (!pendingQuestionId) {
        return null;
      }

      const pending = await this.pendingInteraction.claimById(
        user.id,
        pendingQuestionId,
      );

      if (!pending) {
        return null;
      }

      const matched = pending.payload.optionLabels.find(
        (option) => option.id === optionId,
      );

      return { pending, answerLabel: matched?.label ?? optionId };
    }

    const pending = await this.pendingInteraction.claimHotByUser(user.id);

    if (!pending) {
      return null;
    }

    this.logger.log(
      `[cid=${correlationId}] Resuming pending ${pending.id} from free text for user ${user.id}`,
    );

    return { pending, answerLabel: params.text };
  }

  /**
   * Parses an `ask:<pendingQuestionId>:<optId>` callback into its parts. The
   * prefix is stripped, then the remainder is split once on the first colon so an
   * option id may itself contain colons. Missing parts come back as empty strings
   * (the caller treats an empty id as not-claimable).
   */
  private parseAskCallback(callbackData: string): {
    pendingQuestionId: string;
    optionId: string;
  } {
    const body = callbackData.startsWith(ASK_CALLBACK_PREFIX)
      ? callbackData.slice(ASK_CALLBACK_PREFIX.length)
      : callbackData;
    const separatorIndex = body.indexOf(':');

    if (separatorIndex === -1) {
      return { pendingQuestionId: body, optionId: '' };
    }

    return {
      pendingQuestionId: body.slice(0, separatorIndex),
      optionId: body.slice(separatorIndex + 1),
    };
  }

  /**
   * Rehydrates the suspended `toolRounds` and appends EXACTLY ONE synthetic
   * `ask_user` `tool_result` (ADR 0010 wire invariant), paired to the stored
   * `askToolUseId`, carrying the user's answer as its content. The result is
   * appended to the LAST suspended round — the one whose assistant `tool_use`
   * holds the unanswered `ask_user` call — so the round becomes a valid
   * tool_use→tool_result pair and the Anthropic Messages API never sees an
   * interleaved/unpaired block (which would 400). Returns a fresh array (the
   * persisted payload is left untouched).
   */
  private appendSyntheticAnswer(
    pending: PendingQuestion,
    answerLabel: string,
  ): ToolRound[] {
    const rounds = pending.payload.toolRounds;
    const syntheticResult: ToolResultBlock = {
      toolCallId: pending.askToolUseId,
      content: answerLabel,
    };

    if (rounds.length === 0) {
      // Defensive: a suspended turn always carries the ask round, but never crash
      // a resume — fabricate the minimal valid pair so the model still continues.
      return [
        {
          toolCalls: [
            { id: pending.askToolUseId, name: ToolName.ASK_USER, input: {} },
          ],
          toolResults: [syntheticResult],
        },
      ];
    }

    return rounds.map((round, index) =>
      index === rounds.length - 1
        ? { ...round, toolResults: [...round.toolResults, syntheticResult] }
        : round,
    );
  }

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
   * fresh simple message runs `handleText`; an `answer_callback` / `answer_text`
   * origin runs `resumeAnswer`, which claims the pending `ask_user` question and
   * re-invokes the model with the answer.
   */
  async runTurn(state: TurnState): Promise<void> {
    if (state.origin === 'simple_message') {
      await this.handleText(state.user, {
        text: state.text,
        contentType: state.contentType,
        vendorChatId: state.vendorChatId,
        vendorMessageId: state.vendorMessageId,
        correlationId: state.correlationId,
      });

      return;
    }

    await this.resumeAnswer(state.user, {
      source: state.origin === 'answer_callback' ? 'callback' : 'text',
      text: state.text,
      contentType: state.contentType,
      vendorChatId: state.vendorChatId,
      callbackId: state.callbackId,
      correlationId: state.correlationId,
    });
  }
}
