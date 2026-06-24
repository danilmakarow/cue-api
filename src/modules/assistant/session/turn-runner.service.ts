import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';

import { ConversationStore } from './conversation.store';
import { LastMessageLanguageStore } from './last-message-language.store';
import { PendingInteractionService } from './pending-interaction.store';
import { TurnAuditStore } from './turn-audit.store';
import { ToolRoundAuditPayload, TurnStreamSink } from '../assistant.types';
import { MemoryExtractorService } from '../background/memory-extractor.service';
import { SummarizerService } from '../background/summarizer.service';
import { ASK_CALLBACK_PREFIX } from '../ingress/inbound-router';
import {
  AskSuspension,
  ToolLoopResult,
  ToolLoopService,
} from '../orchestration/tool-loop.service';
import { detectMessageLanguage } from '../reply/detect-message-language';
import { ReplyPresenter } from '../reply/reply-presenter.service';
import {
  StatusAnimation,
  StatusAnimatorService,
} from '../reply/status-animator.service';
import {
  resolveTextStatusLocale,
  resolveVoiceStatusLocale,
  StatusLocale,
} from '../reply/status-phrases';
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
import {
  ChatType,
  InboundKind,
} from '@/modules/external-vendor/external-vendor.types';

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
  /** Chat kind, for the live-status draft private-chat gate (Story 12 / ADR 0012). */
  chatType?: ChatType;
  /** Sender's client language tag, the FALLBACK status-vocabulary signal (Story 12). */
  languageCode?: string;
  /**
   * STT-reported spoken language for a voice turn (v2 Task 4 / ADR 0051) — the
   * highest-priority signal for the post-STT loading-word locale, above message-text
   * detection and `language_code`. Undefined for a typed turn.
   */
  sttLanguage?: string;
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
  /** Chat kind, for the live-status draft private-chat gate (Story 12 / ADR 0012). */
  chatType?: ChatType;
  /** Sender's client language tag, the FALLBACK status-vocabulary signal (Story 12). */
  languageCode?: string;
  /**
   * STT-reported spoken language for a voice answer (v2 Task 4 / ADR 0051) — the
   * highest-priority signal for the post-STT loading-word locale. Undefined for a
   * typed answer.
   */
  sttLanguage?: string;
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
  /** Chat kind, for the live-status draft private-chat gate (Story 12 / ADR 0012). */
  chatType?: ChatType;
  /** Sender's client language tag, the FALLBACK status-vocabulary signal (Story 12). */
  languageCode?: string;
  /**
   * STT-reported spoken language for a voice turn (v2 Task 4 / ADR 0051) — the
   * highest-priority signal for the post-STT loading-word locale. Undefined for a
   * typed turn.
   */
  sttLanguage?: string;
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
 * {@link ReplyPresenter}, suspends/resumes `ask_user` (ADR 0010), and fires the
 * post-turn background jobs. A conflicting write is resolved inside the loop as a
 * recoverable tool result (ADR 0011 default-deny), so there is no hold step here.
 * The command path bypasses this entirely and keeps its deterministic handler on
 * {@link AssistantService}.
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
    private readonly statusAnimator: StatusAnimatorService,
    private readonly lastMessageLanguageStore: LastMessageLanguageStore,
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
    status: StatusAnimation,
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

    // Clear the lingering draft "ghost" before the real question lands (Bot-API
    // equivalent of clear_draft — there is no native flag): a PRIVATE turn never
    // wrote the question into its draft (unlike the streamed answer), so we settle
    // the draft TO the question text first, then send the fresh question + buttons.
    // A no-op on a NON-PRIVATE turn — its morph path already replaces the message.
    await status.settleDraftTo(suspension.question);

    const vendorMessageId = await this.replyPresenter.sendQuestion(
      vendorChatId,
      suspension.question,
      suspension.optionLabels,
      pending.id,
      correlationId,
      status.messageId,
    );

    // Capture the question message's id onto the pending row (R3 / ADR 0058) so a
    // later button tap can morph that original message (strip buttons + append the
    // answer). Only when there ARE options (a plain free-text question has no
    // buttons to clear) and the send returned an id. Degrade-never-throw.
    if (suspension.optionLabels.length > 0 && vendorMessageId) {
      await this.pendingInteraction.attachQuestionMessageId(
        pending.id,
        vendorMessageId,
      );
    }

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
   * Opens the live-status surface for a turn (ADR 0059) and advances it to Working,
   * keyed by the correlation id so it shares the surface with any voice notice
   * already shown for this turn. PRIVATE chats drive an ephemeral native draft
   * (rotating loading word → bare recap text → streamed answer) and the final
   * reply is a FRESH send (the draft self-expires); NON-PRIVATE chats keep the ADR
   * 0053 fallback — one real message edited with recaps and morphed into the reply.
   * The surface choice is internal to the animation: the runner just threads
   * {@link StatusAnimation.messageId} to the presenter (null for a private/draft
   * turn ⇒ a fresh send; the real id for a group ⇒ a morph). Degrades never-throw —
   * a status fault leaves a null `messageId` so the reply sends fresh. The
   * `correlationId` doubles as the per-turn `turnId` for the idempotent
   * StatusSession.
   */
  private async beginStatus(
    correlationId: string,
    vendorChatId: string,
    chatType: ChatType | undefined,
    languageCode: string | undefined,
    messageText: string | undefined,
    sttLanguage: string | undefined,
  ): Promise<StatusAnimation> {
    const animation = await this.statusAnimator.begin({
      vendorChatId,
      turnId: correlationId,
      chatType,
      languageCode,
      // The loading-word locale follows the MESSAGE first (v2 Task 4 / ADR 0051):
      // the STT-reported spoken language wins for a voice turn, else the message's
      // own detected language (a Russian message shows Russian words even under an
      // English `language_code`), with `language_code` as the fallback. A voice
      // transcript flows through `messageText` too (plain text by turn time).
      messageText,
      sttLanguage,
    });

    await animation.startLoading();

    return animation;
  }

  /**
   * Resolves the turn's loading-status {@link StatusLocale} once (R2 / ADR 0055) —
   * the SINGLE language we both (a) RECORD as the user's last-message language and
   * (b) pass to the loop so per-round recaps are written in it. A voice transcript
   * (`VOICE_TRANSCRIPT`) follows the STT-first chain (STT language → transcript →
   * `language_code` → `en`); a typed message follows the text chain (message-text
   * detection → `language_code` → `en`). Pure (the detector is injected), so the
   * computed locale is deterministic for a given input.
   */
  private resolveTurnLocale(
    text: string,
    contentType: ConversationMessageContentType,
    languageCode: string | undefined,
    sttLanguage: string | undefined,
  ): StatusLocale {
    if (contentType === ConversationMessageContentType.VOICE_TRANSCRIPT) {
      return resolveVoiceStatusLocale(
        sttLanguage,
        text,
        languageCode,
        detectMessageLanguage,
      );
    }

    return resolveTextStatusLocale(text, languageCode, detectMessageLanguage);
  }

  /**
   * Fire-and-forget records the turn's resolved locale as the user's last-message
   * language (R2 / ADR 0055) so the NEXT turn's voice pre-STT "Listening…" line can
   * borrow it. Degrade-never-throw: the store swallows its own Redis fault, and the
   * `void` keeps it off the critical path — a record must never block or break the
   * `attempts:1` turn. Called ONLY on turns whose language we actually know (a
   * typed message, a free-text answer, or a voice turn that transcribed
   * successfully); never on an STT-fail early return.
   */
  private recordLastMessageLanguage(
    userId: string,
    locale: StatusLocale,
  ): void {
    void this.lastMessageLanguageStore.record(userId, locale);
  }

  /**
   * Wraps a {@link StatusAnimation} as the loop-facing {@link TurnStreamSink}
   * (ADR 0053) so the L4 loop can render progress onto the live status message
   * WITHOUT knowing about Redis / the vendor (the loop stays L9-blind). Carries
   * BOTH the per-round recap (`showRecap`) and — re-enabled in R3 / ADR 0058 — the
   * streamed answer text (`onToken`, throttled inside the animation), which fills
   * the morph message in as the model writes before the final formatted morph
   * supersedes it. Each method fires-and-forgets the animation's edit (which
   * swallows its own fault), so the sink's contract — synchronous,
   * degrade-never-throw — holds. Used on a fresh model-driven turn AND (R3) on an
   * `ask_user` resume, so a resumed answer streams + recaps like a fresh turn.
   */
  private streamSinkFor(status: StatusAnimation): TurnStreamSink {
    return {
      showRecap: (recap: string): void => {
        void status.showRecap(recap);
      },
      onToken: (snapshot: string): void => {
        status.streamAnswer(snapshot);
      },
    };
  }

  /**
   * Handles a text or voice-transcript turn end to end: open the live-status
   * animation, persist the user turn, build context, run the tool loop, then reply
   * / hold / report a graceful failure, and (on a completed reply) fire the
   * background jobs. The status animation is ALWAYS finalized in a `finally` (no
   * interval leak — ADR 0012) once the real reply has superseded the draft.
   */
  async handleText(user: User, params: HandleTextParams): Promise<void> {
    const correlationId = params.correlationId ?? randomUUID();
    const status = await this.beginStatus(
      correlationId,
      params.vendorChatId,
      params.chatType,
      params.languageCode,
      params.text,
      params.sttLanguage,
    );

    // Resolve the turn's language ONCE (R2 / ADR 0055): we both record it as the
    // user's last-message language (so the next voice pre-STT line can borrow it)
    // and pass it as the recap language so the BACKGROUND recaps speak the user's
    // language. The language is known here (a typed message, or a voice transcript
    // that already succeeded — STT failure returned in the consumer), so we always
    // record on this path. Recording is fire-and-forget — never blocks the turn.
    const recapLocale = this.resolveTurnLocale(
      params.text,
      params.contentType,
      params.languageCode,
      params.sttLanguage,
    );

    this.recordLastMessageLanguage(user.id, recapLocale);

    try {
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
        // The user's language drives the per-round recaps (R2 / ADR 0055): the
        // BACKGROUND recap model is told to write the line in this language.
        recapLocale,
        // Stream the final answer + per-round recaps into the live status draft
        // (Story 13 / ADR 0041). The sink wraps this turn's StatusAnimation and is
        // degrade-never-throw; the real reply below still persists the answer.
        streamSink: this.streamSinkFor(status),
      });

      // Drain any in-flight recap edit before the reply morphs the SAME message,
      // so a late recap can't land after — and revert — the answer (ADR 0053).
      await status.settle();

      await this.finishTurn(
        user,
        conversation,
        params.vendorChatId,
        result,
        correlationId,
        status,
      );
    } finally {
      await status.finalize();
    }
  }

  /**
   * The shared post-loop tail (ADR 0009/0010/0011): persists the audit trail, then
   * branches on the {@link LoopOutcome} — `ask` suspends the turn (ADR 0010),
   * `error` sends the AI-failure line, `unresolved` escalates honestly (alert +
   * reply), and a plain reply runs the false-success guard before sending +
   * persisting and firing the background jobs. A conflicting write never reaches
   * here as a distinct outcome — it is a
   * recoverable tool result the loop already handled (ADR 0011 default-deny).
   * Single-sourced so a fresh turn ({@link handleText}) and an `ask_user` resume
   * ({@link resumeAnswer}) end identically — including the ability to suspend AGAIN
   * when the resumed model asks a follow-up question. Never throws (attempts:1);
   * every helper it calls swallows its own send/persist failure.
   */
  private async finishTurn(
    user: User,
    conversation: Conversation,
    vendorChatId: string,
    result: ToolLoopResult,
    correlationId: string,
    status: StatusAnimation,
  ): Promise<void> {
    const { outcome, rounds, committedWrites, attemptedWrites } = result;
    const statusMessageId = status.messageId;

    // Persist the tool-loop audit trail regardless of how the turn ended.
    await this.persistToolRounds(conversation.id, rounds);

    if (outcome.kind === 'ask') {
      await this.suspendAndAsk(
        user,
        conversation,
        vendorChatId,
        outcome.suspension,
        correlationId,
        status,
      );

      return;
    }

    if (outcome.kind === 'error') {
      await this.replyPresenter.sendText(
        vendorChatId,
        AI_FAILURE_REPLY,
        correlationId,
        statusMessageId,
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
        statusMessageId,
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
      statusMessageId,
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

    // On the WINNING claim of a BUTTON tap (R3 / ADR 0058), morph the ORIGINAL
    // question message: strip its now-answered buttons and append the chosen
    // answer, so the card stops being tappable. Only for a callback source, only
    // when the question's message id was captured (absent on old in-flight rows —
    // skipped gracefully). The double-tap loser got a null claim above and never
    // reaches here, so the keyboard is cleared exactly once. Best-effort — the
    // presenter swallows its own fault — and done BEFORE beginStatus so it never
    // delays the loading surface's appearance.
    await this.maybeMarkQuestionAnswered(claim.pending, params, correlationId);

    // A claimed resume re-invokes the model and produces a reply, so it gets the
    // same live-status animation as a fresh turn — finalized in the `finally`. The
    // user's answer text drives the loading-word locale (v2 Task 4 / ADR 0051),
    // with `language_code` as the fallback.
    const status = await this.beginStatus(
      correlationId,
      params.vendorChatId,
      params.chatType,
      params.languageCode,
      params.text,
      params.sttLanguage,
    );

    // Resolve the answer's language ONCE (R2 / ADR 0055) for the recaps. RECORD it
    // as the user's last-message language ONLY for a TYPED answer (free text /
    // voice transcript) — a button callback's `text` is the `ask:` callback data,
    // not natural language, so recording it would track a meaningless locale. The
    // computed locale still drives any recap language for either source.
    const recapLocale = this.resolveTurnLocale(
      params.text,
      params.contentType,
      params.languageCode,
      params.sttLanguage,
    );

    if (params.source === 'text') {
      this.recordLastMessageLanguage(user.id, recapLocale);
    }

    try {
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
        // The answer's language drives any per-round recaps (R2 / ADR 0055).
        recapLocale,
        // R3 / ADR 0058 + Feature 2: a resume now gets the SAME live-status sink as
        // a fresh turn, so the continued answer streams + per-round recaps render
        // onto the resume's morph message (was none — the resume looked silent
        // mid-flight). Degrade-never-throw, same as the fresh-turn path.
        streamSink: this.streamSinkFor(status),
      });

      // Drain any in-flight recap edit before the reply morphs the SAME message
      // (ADR 0053) — same race guard as the fresh-turn path.
      await status.settle();

      await this.finishTurn(
        user,
        conversation,
        params.vendorChatId,
        result,
        correlationId,
        status,
      );
    } finally {
      await status.finalize();
    }
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
   * On the WINNING claim of a button tap (R3 / ADR 0058), morphs the ORIGINAL
   * `ask_user` question message via the presenter: strips the answered buttons and
   * appends a localized "User selected: <label>" line. A no-op unless the source is
   * a callback AND the captured `questionVendorMessageId` is present (absent on
   * rows suspended before R3 — skipped gracefully). The prefix locale is detected
   * from the QUESTION text (the model's own language) via the text-locale chain.
   * Best-effort — the presenter swallows its own fault — so it never breaks the
   * resume.
   */
  private async maybeMarkQuestionAnswered(
    pending: PendingQuestion,
    params: ResumeAnswerParams,
    correlationId: string,
  ): Promise<void> {
    if (params.source !== 'callback') {
      return;
    }

    const questionMessageId = pending.payload.questionVendorMessageId;

    if (!questionMessageId) {
      return;
    }

    const { pendingQuestionId, optionId } = this.parseAskCallback(params.text);

    if (!pendingQuestionId) {
      return;
    }

    const matched = pending.payload.optionLabels.find(
      (option) => option.id === optionId,
    );
    const answerLabel = matched?.label ?? optionId;
    const locale = resolveTextStatusLocale(
      pending.payload.question,
      params.languageCode,
      detectMessageLanguage,
    );

    await this.replyPresenter.markQuestionAnswered(
      params.vendorChatId,
      questionMessageId,
      pending.payload.question,
      answerLabel,
      locale,
      correlationId,
    );
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
    chatType?: ChatType;
    languageCode?: string;
    sttLanguage?: string;
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
      chatType: params.chatType,
      languageCode: params.languageCode,
      sttLanguage: params.sttLanguage,
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
        chatType: state.chatType,
        languageCode: state.languageCode,
        sttLanguage: state.sttLanguage,
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
      chatType: state.chatType,
      languageCode: state.languageCode,
      sttLanguage: state.sttLanguage,
    });
  }
}
