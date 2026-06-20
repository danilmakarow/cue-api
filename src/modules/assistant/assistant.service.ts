import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { Redis } from 'ioredis';

import { AssistantConfig } from './assistant.config';
import {
  AskUserOption,
  ConflictCallbackAction,
  CorrectionReason,
  HeldConflictBatch,
  HeldConflictWrite,
  HeldRecurrence,
  HeldWriteAction,
  ToolDispatchContext,
  ToolRoundAuditPayload,
  ToolStepRecord,
} from './assistant.types';
import { MemoryExtractorService } from './background/memory-extractor.service';
import { SummarizerService } from './background/summarizer.service';
import { CommandHandlerService } from './commands/command-handler.service';
import { ContextBuilderService } from './context-builder.service';
import { ASK_CALLBACK_PREFIX } from './ingress/inbound-router';
import { PendingInteractionService } from './session/pending-interaction.store';
import { HandleMap } from './tools/handle-map';
import { ToolDispatcherService } from './tools/tool-dispatcher.service';
import { SCHEDULE_FETCH_TOOLS, WRITE_TOOLS } from './tools/tool-registry';
import { ToolName } from './tools/tool-schemas';
import { heldConflictKey } from '../redis/redis.constants';
import { REDIS_CLIENT } from '../redis/redis.module';
import { AiConnector } from '@/modules/ai/ai-connector.abstract';
import { ACTIVE_AI_CONNECTOR } from '@/modules/ai/ai.module';
import {
  AiModelRole,
  AiStopReason,
  AiToolChoice,
  PromptBlock,
  PromptRole,
  ToolRound,
  ToolResultBlock,
} from '@/modules/ai/ai.types';
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
  ConversationDatabaseService,
  ConversationMessageDatabaseService,
} from '@/modules/database/services';
import { ExternalVendorConnector } from '@/modules/external-vendor/external-vendor-connector.abstract';
import { ACTIVE_VENDOR_CONNECTOR } from '@/modules/external-vendor/external-vendor.module';
import { CreateRecurrenceRuleDto } from '@/modules/recurrence-rule/dtos';
import {
  RecurringEditProposal,
  TaskService,
} from '@/modules/task/task.service';

/** Reply sent when the AI fails after its bounded retries (spec error table). */
const AI_FAILURE_REPLY =
  "I'm having trouble reaching my reasoning just now — try again in a moment.";

/** Reply sent when a turn hits the overall tool round-trip ceiling. */
const ROUNDTRIP_CEILING_REPLY =
  'That took more steps than I can take in one go — could you narrow it down a little?';

/**
 * Reply sent when the model's final, no-tool-call turn stopped on `max_tokens`:
 * the text we hold is a possibly mid-sentence fragment, so we send an honest
 * "I had to cut that short" rather than relay a truncated reply that could read
 * as complete (or, worse, half-confirm an action). The user can ask to continue.
 */
const TRUNCATED_REPLY =
  "I had to cut that short — ask me to continue and I'll finish.";

/**
 * Reply sent when the model's final turn stopped on `refusal`: the model
 * declined to answer, so we surface an honest, neutral decline instead of
 * relaying whatever partial text (if any) rode along with the refusal.
 */
const REFUSAL_REPLY =
  "I'm not able to help with that one — try rephrasing, or ask me something else.";

/** Tool result returned once the per-turn schedule-fetch cap is reached. */
const SCHEDULE_CAP_TOOL_RESULT =
  'Schedule-fetch limit reached for this turn; proceed with the information already gathered.';

/** Reply sent when a held confirmation has expired before the user tapped. */
const HELD_EXPIRED_REPLY =
  'That confirmation expired — please ask again and I will sort it out.';

/**
 * Max characters of a tool result kept in the persisted audit payload. The full
 * result was already fed to the model live; the audit copy only needs to be
 * diagnostic, so a long agenda / tool dump is capped to bound jsonb row growth.
 */
const MAX_AUDIT_RESULT_CHARS = 2000;

/**
 * Reply sent in place of a success-sounding message when the model claimed to
 * have changed the calendar but no write tool actually committed this turn
 * (failure mode #1 — narration without tools / all writes failed). We refuse to
 * confirm an action that never happened.
 */
const CLAIM_WITHOUT_WRITE_REPLY =
  "Hmm — I don't think that actually saved. Nothing was changed on my side. Could you try again?";

/**
 * Corrective USER message appended to the conversation when the model narrates a
 * change but calls no tools (ADR 0009 narration re-drive). It nudges the model
 * to actually call the tools on the next round (issued with `tool_choice:'any'`)
 * or to ask a clarifying question instead. This is a plain user `PromptBlock` —
 * NEVER a synthetic `tool_result` (a `tool_result` with no matching `tool_use`
 * is an Anthropic 400).
 */
const CORRECTIVE_NUDGE =
  'You said you would make changes but called no tools, so nothing was saved. ' +
  'If you intend to act, call the tools now to actually make the changes; ' +
  'otherwise tell me what you need from me.';

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
const MUTATION_CLAIM_PATTERN =
  /\bI(?:['’]ve|['’]ll|['’]m| have| just| will| already)?\s+(?:created|added|booked|scheduled|saved|set up|moved|rescheduled|updated|deleted|removed|cancell?ed|put (?:it|that|them))\b|\b(?:created|added|booked|scheduled|moved|saved|updated|rescheduled|deleted|removed|cancell?ed) (?:it|them|that|your)\b|\b(?:creating|adding|booking|scheduling|saving|setting up|moving|rescheduling|updating|deleting|removing|cancell?ing)\b|созда(?:л|ю|м|ла)|добав(?:ил|лю|ляю|ила)|запис(?:ал|ала)|запланир(?:овал|ую)|перенёс|перенесл[аи]?|перенесу|обнов(?:ил|лю)|удал(?:ил|ю|ила)|сохран(?:ил|ю)/iu;

/**
 * Vetoes a mutation "claim" that is actually a non-action: a negation ("nothing
 * was deleted", "I couldn't add"), a report of existing state ("already
 * booked"), or an offer/question ("want me to add?", trailing "?"). When this
 * matches we never override the reply — the model is being honest, or asking.
 */
const CLAIM_VETO_PATTERN =
  /\b(?:not|n['’]t|nothing|never|already|unable|cannot|can['’]t|couldn['’]t|could not|won['’]t|would not|didn['’]t|don['’]t|no longer|want me to|shall i|should i|would you like)\b|(?:^|[\s,])(?:не|ни|ничего|нельзя|уже|хочешь|хотите)(?=[\s,.!?]|$)|не удалось|не получилось|\?\s*$/iu;

/**
 * The suspended session of an `ask_user` turn (ADR 0010), carried on the `ask`
 * {@link LoopOutcome} so the orchestrator can persist + mirror it and resume on
 * the user's answer. `toolRounds` are the accumulated rounds INCLUDING the
 * assistant round that holds the `ask_user` `tool_use` but deliberately NOT its
 * `tool_result` (the wire invariant — synthesized on resume against
 * {@link askToolUseId}). The same shape feeds {@link PendingQuestionPayload}.
 */
interface AskSuspension {
  toolRounds: ToolRound[];
  askToolUseId: string;
  question: string;
  optionLabels: AskUserOption[];
}

/** The outcome of the tool-use loop for one user turn. */
type LoopOutcome =
  | { kind: 'reply'; text: string }
  | { kind: 'held'; held: HeldConflictWrite[]; promptText: string }
  | {
      /**
       * The model called `ask_user` (ADR 0010): suspend the turn. Carries the
       * suspended session so the orchestrator persists a `pending_question` row,
       * mirrors it to Redis, and sends the question — then ends the turn (never
       * re-invokes the model here; the user's answer drives the resume).
       */
      kind: 'ask';
      suspension: AskSuspension;
    }
  | {
      /**
       * The narration re-drive (ADR 0009) ran out of corrections without the
       * model committing the action it claimed: escalate (alert + honest reply),
       * never throw. Carries the budget actually spent for the structured event.
       */
      kind: 'unresolved';
      corrections: number;
    }
  | { kind: 'error' };

/**
 * The classification of a terminal (no-tool-call) turn (ADR 0009).
 * `genuine` = a real answer / clarifying question / honest failure → send it.
 * `narration_without_write` = the model described a change it never made (zero
 * tool calls, zero commits, not a question) → re-drive it. The trigger is
 * STRUCTURAL; the optional `reason` is a lexical logging hint only.
 */
type TerminalClassification =
  | { kind: 'genuine' }
  | { kind: 'narration_without_write'; reason: CorrectionReason };

/**
 * The full result of one tool-use loop: the user-facing {@link LoopOutcome}, the
 * per-round audit trail to persist, and how many writes actually committed (so
 * the caller can refuse to claim success when none did).
 */
interface ToolLoopResult {
  outcome: LoopOutcome;
  rounds: ToolRoundAuditPayload[];
  /** Write tools that committed (non-error, non-held) — the saved-changes count. */
  committedWrites: number;
  /** Write tools dispatched this turn (committed or errored) — for the guard. */
  attemptedWrites: number;
}

/** A held conflict paired with the per-conflict prompt the dispatcher built. */
interface CollectedHeldConflict {
  write: HeldConflictWrite;
  promptText: string;
}

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

/** Parameters for handling a deterministic slash command. */
export interface HandleCommandParams {
  command: string;
  args: string[];
  vendorChatId: string;
  /** Correlation id threaded from the webhook; minted here if absent. */
  correlationId?: string;
}

/** Parameters for resolving an inline-keyboard callback (button tap). */
export interface HandleCallbackParams {
  callbackId: string;
  callbackData: string;
  vendorChatId: string;
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
 * The assistant orchestrator: it owns the inbound pipeline's post-resolution
 * stages — persist the turn, build context, drive the bounded tool-use loop,
 * reply, hold-and-confirm conflicting writes, and fire the post-turn background
 * jobs. It dispatches tools only into existing feature services (via the
 * dispatcher) and never re-invokes the model to resolve a conflict (ADR 0006).
 */
@Injectable()
export class AssistantService {
  private readonly logger = new Logger(AssistantService.name);

  constructor(
    @Inject(ACTIVE_AI_CONNECTOR) private readonly ai: AiConnector,
    @Inject(ACTIVE_VENDOR_CONNECTOR)
    private readonly vendor: ExternalVendorConnector,
    @Inject(ACTIVE_ALERT_CONNECTOR) private readonly alert: AlertConnector,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly config: AssistantConfig,
    private readonly contextBuilder: ContextBuilderService,
    private readonly toolDispatcher: ToolDispatcherService,
    private readonly commandHandler: CommandHandlerService,
    private readonly summarizer: SummarizerService,
    private readonly memoryExtractor: MemoryExtractorService,
    private readonly taskService: TaskService,
    private readonly conversationDatabaseService: ConversationDatabaseService,
    private readonly conversationMessageDatabaseService: ConversationMessageDatabaseService,
    private readonly pendingInteraction: PendingInteractionService,
  ) {}

  /**
   * Returns the user's perpetual conversation, creating it on first contact.
   */
  private async getOrCreateConversation(userId: string): Promise<Conversation> {
    const existing =
      await this.conversationDatabaseService.findByUserId(userId);

    if (existing) {
      return existing;
    }

    const created = this.conversationDatabaseService.createInstance({
      userId,
      lastActivityAt: new Date(),
    });

    return this.conversationDatabaseService.save(created);
  }

  /**
   * Persists one conversation message and stamps the conversation's
   * last-activity time.
   */
  private async persistMessage(
    conversation: Conversation,
    role: ConversationMessageRole,
    contentType: ConversationMessageContentType,
    content: string,
    vendorMessageId: string | null,
  ): Promise<void> {
    const message = this.conversationMessageDatabaseService.createInstance({
      conversationId: conversation.id,
      role,
      contentType,
      content,
      vendorMessageId,
    });

    await this.conversationMessageDatabaseService.save(message);

    conversation.lastActivityAt = new Date();

    await this.conversationDatabaseService.save(conversation);
  }

  /**
   * Persists the tool-loop audit trail: one `role = tool` message per round,
   * with the structured calls/results in `toolPayload`. These rows are excluded
   * from the verbatim prompt window (DB service), so they are pure forensics —
   * "what did the assistant actually do on this turn" becomes a SQL query. Never
   * bumps `lastActivityAt` (the user/assistant turns bracket the round already).
   *
   * Each turn writes up to `maxToolRoundtrips` rows and these are never pruned —
   * TODO(retention): add a scheduled prune of `role = tool` rows older than N
   * days (the `(conversationId, createdAt)` index + `@nestjs/schedule` exist)
   * before this carries sustained traffic.
   */
  private async persistToolRounds(
    conversationId: string,
    rounds: ToolRoundAuditPayload[],
  ): Promise<void> {
    for (const round of rounds) {
      const summary = round.steps
        .map((step) => {
          const status = step.held ? 'held' : step.isError ? 'error' : 'ok';

          return `${step.name}(${status})`;
        })
        .join(', ');

      const boundedSteps = round.steps.map((step) =>
        step.resultContent.length > MAX_AUDIT_RESULT_CHARS
          ? {
              ...step,
              resultContent: `${step.resultContent.slice(0, MAX_AUDIT_RESULT_CHARS)}… [truncated]`,
            }
          : step,
      );

      const message = this.conversationMessageDatabaseService.createInstance({
        conversationId,
        role: ConversationMessageRole.TOOL,
        contentType: ConversationMessageContentType.TOOL_STEP,
        content: `[${round.correlationId}] round ${round.round} ${round.stopReason}: ${
          summary || 'no tools'
        }`,
        toolPayload: { ...round, steps: boundedSteps },
        vendorMessageId: null,
      });

      await this.conversationMessageDatabaseService.save(message);
    }
  }

  /**
   * Sends a plain text reply, swallowing a send failure (e.g. the user blocked
   * the bot) with a log rather than crashing the turn. Returns the vendor
   * message id when the send succeeded, or null when it failed.
   */
  private async sendReply(
    vendorChatId: string,
    text: string,
    correlationId?: string,
  ): Promise<string | null> {
    try {
      const ref = await this.vendor.sendMessage({ vendorChatId }, { text });

      return ref.vendorMessageId;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';

      this.logger.warn(
        `[cid=${correlationId ?? 'none'}] Failed to send reply to ${vendorChatId}: ${message}`,
      );

      return null;
    }
  }

  /**
   * Drives the consolidated tool-use loop for one turn. Calls the model; on
   * `tool_use` it dispatches each tool (enforcing the schedule-fetch read cap),
   * feeds the results back, and re-invokes — until `end_turn`, a held conflict,
   * the overall round-trip ceiling, or a terminal AI error.
   */
  private async runToolLoop(
    user: User,
    conversationId: string,
    currentMessageText: string,
    correlationId: string,
    resumeRounds?: ToolRound[],
  ): Promise<ToolLoopResult> {
    // One HandleMap per user turn: the context builder seeds it with an alias
    // per rendered agenda occurrence, and the SAME instance threads into every
    // tool-loop dispatch so those handles resolve when the model later mutates a
    // task. Aliases keep counting up within the turn (the dispatcher's list_tasks
    // appends to it) and stay stable across rounds.
    //
    // On an `ask_user` RESUME (ADR 0010) `resumeRounds` rehydrates the suspended
    // turn's accumulated rounds — including the round carrying the `ask_user`
    // `tool_use` WITH its now-synthesized answer `tool_result` already appended by
    // the caller — so the very next `complete` continues exactly where the turn
    // paused. The HandleMap is fresh (a stale cross-turn alias must not resolve);
    // the model re-reads the day if it needs to act on a task.
    const handleMap = new HandleMap();
    const toolRounds: ToolRound[] = resumeRounds ? [...resumeRounds] : [];
    const rounds: ToolRoundAuditPayload[] = [];
    let scheduleFetches = 0;
    let committedWrites = 0;
    let attemptedWrites = 0;
    // Narration re-drive bookkeeping (ADR 0009). `corrections` counts the
    // corrective re-invocations made so far; `forcedToolChoice` is set to 'any'
    // for the SINGLE round immediately after a corrective nudge, then cleared.
    let corrections = 0;
    let forcedToolChoice: AiToolChoice | undefined;

    try {
      // Context assembly is inside the try so a build failure (e.g. the rolling
      // summary or agenda read throws) yields kind:'error' → AI_FAILURE_REPLY
      // rather than escaping runToolLoop. On an attempts:1 inbound turn an
      // uncaught throw here would surface no user-facing reply at all; every
      // inbound turn must answer, so this path degrades gracefully like any
      // other terminal failure.
      const prompt = await this.contextBuilder.build({
        user,
        conversationId,
        currentMessageText,
        handleMap,
      });
      // A working copy of the volatile message tail: the narration re-drive
      // appends a corrective USER block here (ADR 0009) so the nudge persists
      // into every subsequent round. The cached prefix (system + tools) is
      // untouched, so this never disturbs the ADR 0004 cache breakpoints.
      const messages: PromptBlock[] = [...prompt.messages];
      const dispatchContext: ToolDispatchContext = {
        userId: user.id,
        user,
        handleMap,
        correlationId,
      };

      for (
        let roundtrip = 0;
        roundtrip < this.config.maxToolRoundtrips;
        roundtrip += 1
      ) {
        // The forced tool choice (set by a corrective nudge) applies to THIS
        // round only; clear it immediately so the next round reverts to 'auto'.
        const roundToolChoice = forcedToolChoice;

        forcedToolChoice = undefined;

        const result = await this.ai.complete({
          modelRole: AiModelRole.MAIN,
          system: prompt.system,
          messages,
          tools: prompt.tools,
          toolRounds,
          toolChoice: roundToolChoice,
          features: { promptCaching: true, contextEditing: true },
          traceId: correlationId,
        });

        // Continue purely on whether the turn emitted tool calls — NOT on the
        // stop reason. A turn can carry `tool_use` blocks under a stop reason
        // other than TOOL_USE (e.g. MAX_TOKENS, when the model is cut off mid
        // tool-call burst): the previous `stopReason !== TOOL_USE` clause would
        // have dropped those calls on the floor and returned a truncated reply,
        // leaving the user's requested writes silently undispatched. Gating on
        // content (`toolCalls?.length`) means every requested tool call is
        // dispatched regardless of stop reason, and we only terminate when the
        // model asked for no tools at all.
        if (!result.toolCalls?.length) {
          const classification = this.classifyTerminalTurn(
            result.stopReason,
            result.text,
            committedWrites,
            attemptedWrites,
          );

          // Genuine terminal (a real answer, a clarifying question, an honest
          // failure, or a committed write): send it, branching on stop reason.
          if (classification.kind === 'genuine') {
            return {
              outcome: {
                kind: 'reply',
                text: this.terminalReplyText(result.stopReason, result.text),
              },
              rounds,
              committedWrites,
              attemptedWrites,
            };
          }

          // Narration without a write (ADR 0009). Re-drive is disabled
          // (kill-switch) or out of budget → stop here; the caller's detect-and
          // -mask guard turns the false-success text into an honest reply
          // (kill-switch) and the budget-exhausted case escalates as
          // `unresolved`.
          if (corrections >= this.config.maxCorrections) {
            // maxCorrections === 0 is the kill-switch: return the model's text
            // as a normal reply so the existing isFalseSuccessReply guard masks
            // it (today's detect-and-mask behaviour, unchanged).
            if (this.config.maxCorrections === 0) {
              return {
                outcome: {
                  kind: 'reply',
                  text: this.terminalReplyText(result.stopReason, result.text),
                },
                rounds,
                committedWrites,
                attemptedWrites,
              };
            }

            // Budget exhausted with re-drive enabled: escalate honestly.
            rounds.push(
              this.buildNarrationAuditRound(
                correlationId,
                roundtrip,
                result.stopReason,
                result.text,
                classification.reason,
              ),
            );

            return {
              outcome: { kind: 'unresolved', corrections },
              rounds,
              committedWrites,
              attemptedWrites,
            };
          }

          // Within budget: record the narration round, append the corrective
          // USER nudge (NOT a synthetic tool_result), force a tool call on the
          // NEXT round only, and re-invoke the model.
          rounds.push(
            this.buildNarrationAuditRound(
              correlationId,
              roundtrip,
              result.stopReason,
              result.text,
              classification.reason,
            ),
          );

          if (result.text && result.text.length > 0) {
            messages.push({
              role: PromptRole.ASSISTANT,
              content: result.text,
            });
          }

          messages.push({ role: PromptRole.USER, content: CORRECTIVE_NUDGE });

          forcedToolChoice = 'any';
          corrections += 1;

          this.logger.warn(
            `[cid=${correlationId}] Narration without write (reason=${classification.reason}); ` +
              `re-driving with tool_choice:any (correction ${corrections}/${this.config.maxCorrections})`,
          );

          continue;
        }

        const roundToolCalls = result.toolCalls;
        const roundResults: ToolRound['toolResults'] = [];
        const steps: ToolStepRecord[] = [];
        const heldConflicts: CollectedHeldConflict[] = [];

        for (const toolCall of roundToolCalls) {
          if (SCHEDULE_FETCH_TOOLS.has(toolCall.name)) {
            if (scheduleFetches >= this.config.maxScheduleFetches) {
              roundResults.push({
                toolCallId: toolCall.id,
                content: SCHEDULE_CAP_TOOL_RESULT,
                isError: false,
              });
              steps.push({
                name: toolCall.name,
                input: toolCall.input,
                resultContent: SCHEDULE_CAP_TOOL_RESULT,
                isError: false,
                held: false,
              });
              continue;
            }

            scheduleFetches += 1;
          }

          const outcome = await this.toolDispatcher.dispatch(
            toolCall,
            dispatchContext,
          );

          // `ask_user` (ADR 0010): the model wants to suspend and ask the user.
          // STOP here and return the suspended session — the accumulated rounds
          // INCLUDING this round's assistant `tool_use`s but WITHOUT this call's
          // `tool_result` (the wire invariant; the answer is appended on resume).
          // Any sibling tool calls already dispatched this round keep their
          // results, so the paired structure stays valid; the ask call alone is
          // left unpaired-until-resume. Never re-invokes the model here.
          if (outcome.askUser) {
            steps.push({
              name: toolCall.name,
              input: toolCall.input,
              resultContent: outcome.content,
              isError: false,
              held: false,
            });
            rounds.push({
              correlationId,
              round: roundtrip,
              stopReason: result.stopReason,
              assistantText: result.text ?? null,
              steps,
            });
            toolRounds.push({
              toolCalls: roundToolCalls,
              toolResults: roundResults,
              assistantText: result.text,
            });

            return {
              outcome: {
                kind: 'ask',
                suspension: {
                  toolRounds,
                  askToolUseId: toolCall.id,
                  question: outcome.askUser.question,
                  optionLabels: outcome.askUser.options,
                },
              },
              rounds,
              committedWrites,
              attemptedWrites,
            };
          }

          // A held conflict no longer aborts the batch (failure mode #2): record
          // it, hand the model a benign tool result, and keep dispatching the
          // rest of the round — non-conflicting writes still commit. All collected
          // conflicts are confirmed together after the round. A single-write tool
          // (`create_task` / `update_task`) reports ONE via `heldConflict` and
          // produces no committed write, so it stops here entirely.
          if (outcome.heldConflict) {
            const heldContent =
              'Held for the user to confirm (time conflict); not executed yet.';

            heldConflicts.push({
              write: outcome.heldConflict.write,
              promptText: outcome.heldConflict.promptText,
            });
            roundResults.push({
              toolCallId: toolCall.id,
              content: heldContent,
              isError: false,
            });
            steps.push({
              name: toolCall.name,
              input: toolCall.input,
              resultContent: heldContent,
              isError: false,
              held: true,
            });
            continue;
          }

          // A BATCH tool (`create_tasks`) reports every held item via the plural
          // `heldConflicts`; collect them all into the same batch-hold, then fall
          // through so its own (real) tool result and committed/attempted counts
          // are still recorded — a batch can both hold some items AND commit others.
          if (outcome.heldConflicts) {
            for (const held of outcome.heldConflicts) {
              heldConflicts.push({
                write: held.write,
                promptText: held.promptText,
              });
            }
          }

          const isError = outcome.isError ?? false;

          roundResults.push({
            toolCallId: toolCall.id,
            content: outcome.content,
            isError,
          });
          steps.push({
            name: toolCall.name,
            input: toolCall.input,
            resultContent: outcome.content,
            isError,
            held: (outcome.heldConflicts?.length ?? 0) > 0,
          });

          // Write accounting: a batch tool supplies its own committed/attempted
          // counts; a single-write tool omits them, so fall back to today's exact
          // per-call +1 (one attempt; one commit unless it errored). Non-write
          // tools touch neither counter.
          if (WRITE_TOOLS.has(toolCall.name)) {
            attemptedWrites += outcome.attemptedCount ?? 1;
            committedWrites += outcome.committedCount ?? (isError ? 0 : 1);
          }
        }

        rounds.push({
          correlationId,
          round: roundtrip,
          stopReason: result.stopReason,
          assistantText: result.text ?? null,
          steps,
        });
        toolRounds.push({
          toolCalls: roundToolCalls,
          toolResults: roundResults,
          assistantText: result.text,
        });

        if (heldConflicts.length > 0) {
          return {
            outcome: {
              kind: 'held',
              held: heldConflicts.map((conflict) => conflict.write),
              promptText: this.buildHeldPrompt(heldConflicts, committedWrites),
            },
            rounds,
            committedWrites,
            attemptedWrites,
          };
        }
      }

      return {
        outcome: { kind: 'reply', text: ROUNDTRIP_CEILING_REPLY },
        rounds,
        committedWrites,
        attemptedWrites,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';

      this.logger.error(
        `[cid=${correlationId}] Tool loop failed for user ${user.id}: ${message}`,
      );

      return {
        outcome: { kind: 'error' },
        rounds,
        committedWrites,
        attemptedWrites,
      };
    }
  }

  /**
   * Resolves the user-facing text for a terminal (no-tool-call) turn, branching
   * on the stop reason so we never relay an unreliable fragment. MAX_TOKENS means
   * the held text is a truncated cut-off, so we send an honest "cut that short"
   * rather than a reply that could read as complete; REFUSAL means the model
   * declined, so we surface a neutral decline; any other terminal reason relays
   * the model's own text, falling back to the round-trip-ceiling line when it
   * produced none.
   */
  private terminalReplyText(
    stopReason: AiStopReason,
    text: string | undefined,
  ): string {
    if (stopReason === AiStopReason.MAX_TOKENS) {
      return TRUNCATED_REPLY;
    }

    if (stopReason === AiStopReason.REFUSAL) {
      return REFUSAL_REPLY;
    }

    return text ?? ROUNDTRIP_CEILING_REPLY;
  }

  /**
   * Builds the confirmation prompt for one or more held conflicts. A single
   * conflict with nothing else committed keeps the dispatcher's own wording; a
   * batch (or a partial success) reports how many already saved and lists the
   * overlapping items so the user confirms or cancels the whole group at once.
   */
  private buildHeldPrompt(
    held: CollectedHeldConflict[],
    committedWrites: number,
  ): string {
    if (held.length === 1 && committedWrites === 0) {
      return held[0].promptText;
    }

    const titles = held
      .map((conflict) => this.heldActionLabel(conflict.write.action))
      .join(', ');
    const prefix =
      committedWrites > 0
        ? `Saved ${committedWrites} change${committedWrites === 1 ? '' : 's'}. `
        : '';
    const overlap =
      held.length === 1
        ? `1 overlaps an existing event (${titles})`
        : `${held.length} overlap existing events (${titles})`;

    return `${prefix}${overlap} — book ${
      held.length === 1 ? 'it' : 'them all'
    } anyway, or cancel?`;
  }

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
  private classifyTerminalTurn(
    stopReason: AiStopReason,
    text: string | undefined,
    committedWrites: number,
    attemptedWrites: number,
  ): TerminalClassification {
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
  }

  /**
   * Builds the audit row for a re-driven narration round (ADR 0009): a terminal
   * turn that produced text but no tool calls, tagged with the diagnostic
   * `correctionReason` so re-drive frequency is greppable. It carries no steps
   * (no tools ran).
   */
  private buildNarrationAuditRound(
    correlationId: string,
    round: number,
    stopReason: AiStopReason,
    text: string | undefined,
    reason: CorrectionReason,
  ): ToolRoundAuditPayload {
    return {
      correlationId,
      round,
      stopReason,
      assistantText: text ?? null,
      steps: [],
      correctionReason: reason,
    };
  }

  /**
   * Decides whether a reply falsely claims success and must be replaced (failure
   * mode #1). Fires only when nothing committed, and never over an honest or
   * read-only reply (the veto). Two confident signals:
   *  - a write WAS attempted but none committed → it failed; unless the reply
   *    already admits that (veto), the success-sounding text is wrong; or
   *  - NO write was attempted at all, yet the reply asserts a mutation (the
   *    pure-narration trap, e.g. "Создаю все семь" with zero tool calls).
   * A read-only Q&A turn (no write attempted, no mutation claim) never fires.
   */
  private isFalseSuccessReply(
    text: string,
    committedWrites: number,
    attemptedWrites: number,
  ): boolean {
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

    await this.redis.set(
      heldConflictKey(token),
      JSON.stringify(batch),
      'EX',
      this.config.heldConflictTtlSeconds,
    );

    await this.vendor.sendActions(
      { vendorChatId },
      {
        text: promptText,
        buttons: [
          [
            {
              label: held.length > 1 ? 'Book all anyway' : 'Book anyway',
              callbackData: `${ConflictCallbackAction.CONFIRM}:${token}`,
            },
            {
              label: 'Cancel',
              callbackData: `${ConflictCallbackAction.CANCEL}:${token}`,
            },
          ],
        ],
      },
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

    const vendorMessageId = await this.sendQuestion(
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
   * Sends an `ask_user` question: a plain text message when there are no options,
   * else an inline keyboard with one button per option (callback data
   * `ask:<pendingQuestionId>:<optId>`). Each path swallows a send failure with a
   * log (mirroring {@link sendReply}) and returns the outbound vendor message id
   * (or null) so the persisted assistant message can reference it. A keyboard send
   * has no per-message id to thread back, so it returns null.
   */
  private async sendQuestion(
    vendorChatId: string,
    question: string,
    options: AskUserOption[],
    pendingQuestionId: string,
    correlationId: string,
  ): Promise<string | null> {
    if (options.length === 0) {
      return this.sendReply(vendorChatId, question, correlationId);
    }

    try {
      await this.vendor.sendActions(
        { vendorChatId },
        {
          text: question,
          buttons: [
            options.map((option) => ({
              label: option.label,
              callbackData: `${ASK_CALLBACK_PREFIX}${pendingQuestionId}:${option.id}`,
            })),
          ],
        },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';

      this.logger.warn(
        `[cid=${correlationId}] Failed to send ask_user keyboard to ${vendorChatId}: ${message}`,
      );
    }

    return null;
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
   * Maps a {@link HeldRecurrence} (the rule grammar as it survived the Redis JSON
   * round-trip) back to a `CreateRecurrenceRuleDto` for replay. The string enum
   * fields are cast to their nominal enum types — the held values are exactly the
   * enum members, only their static type was widened to `string` for storage.
   */
  private toCreateRecurrenceDto(
    recurrence: HeldRecurrence,
  ): CreateRecurrenceRuleDto {
    return {
      frequency: recurrence.frequency as CreateRecurrenceRuleDto['frequency'],
      interval: recurrence.interval,
      byWeekday: recurrence.byWeekday,
      byMonthDay: recurrence.byMonthDay,
      byMonth: recurrence.byMonth,
      endType: recurrence.endType as CreateRecurrenceRuleDto['endType'],
      endDate: recurrence.endDate,
      count: recurrence.count,
    };
  }

  /**
   * A short human-readable label for a held action, used in the failure log and
   * the "couldn't apply X" reply.
   */
  private heldActionLabel(action: HeldWriteAction): string {
    if (
      action.kind === 'create_event' ||
      action.kind === 'create_recurring_event'
    ) {
      return `"${action.title}"`;
    }

    return 'a move';
  }

  /**
   * Executes ONE confirmed held action verbatim, bypassing the conflict check the
   * user already overrode ("book anyway"). Returns whether it counts as a `booked`
   * (create) or `moved` (update) outcome plus a label, so {@link executeHeldBatch}
   * can summarize the batch. The recurring shapes (Story 9) replay the exact
   * `TaskService` call the dispatcher's check would have committed: a recurring
   * create with its full payload + rule, a recurring edit at its chosen scope.
   */
  private async executeHeldAction(
    action: HeldWriteAction,
    userId: string,
  ): Promise<{ kind: 'booked' | 'moved'; label: string }> {
    if (action.kind === 'create_event') {
      const created = await this.taskService.create(userId, {
        calendarId: action.calendarId,
        title: action.title,
        notes: action.notes ?? undefined,
        startAt: action.startAt,
        endAt: action.endAt ?? undefined,
        timezone: action.timezone,
      });

      return { kind: 'booked', label: `"${created.title}"` };
    }

    if (action.kind === 'create_recurring_event') {
      const created = await this.taskService.create(userId, {
        calendarId: action.calendarId,
        title: action.title,
        notes: action.notes ?? undefined,
        startAt: action.startAt,
        endAt: action.endAt,
        isAllDay: action.isAllDay,
        timezone: action.timezone,
        requiresCompletion: action.requiresCompletion,
        groupId: action.groupId ?? undefined,
        recurrence: this.toCreateRecurrenceDto(action.recurrence),
      });

      return { kind: 'booked', label: `"${created.title}"` };
    }

    if (action.kind === 'update_recurring_event') {
      const updated = await this.executeHeldRecurringEdit(action, userId);

      return { kind: 'moved', label: `"${updated.title}"` };
    }

    const updated = await this.taskService.update(userId, action.taskId, {
      startAt: action.startAt,
      endAt: action.endAt,
    });

    return { kind: 'moved', label: `"${updated.title}"` };
  }

  /**
   * Replays a confirmed recurring EDIT at its originally chosen scope (Story 9):
   * `all` updates the master, `this_and_following` splits the series — the same
   * two `TaskService` calls the dispatcher would have made, now with the conflict
   * check bypassed. Returns the resulting task so the batch summary can name it.
   */
  private async executeHeldRecurringEdit(
    action: Extract<HeldWriteAction, { kind: 'update_recurring_event' }>,
    userId: string,
  ): Promise<{ title: string }> {
    const changes: RecurringEditProposal & {
      groupId?: string | null;
      recurrence?: CreateRecurrenceRuleDto;
    } = {
      ...(action.title !== null ? { title: action.title } : {}),
      ...(action.startAt !== null ? { startAt: action.startAt } : {}),
      ...(action.endAt !== null ? { endAt: action.endAt } : {}),
      ...(action.groupId !== null ? { groupId: action.groupId } : {}),
      ...(action.recurrence
        ? { recurrence: this.toCreateRecurrenceDto(action.recurrence) }
        : {}),
    };

    if (action.editScope === 'this_and_following') {
      return this.taskService.splitSeries(
        userId,
        action.taskId,
        new Date(action.originalStart),
        changes,
      );
    }

    return this.taskService.update(userId, action.taskId, changes);
  }

  /**
   * Executes a confirmed held batch deterministically — the conflict gate is
   * bypassed here (the user already chose "book anyway"). Each action runs in its
   * own try/catch so one failure cannot orphan the others or throw out of the
   * handler: the Redis token has already been burned (getdel), so a throw here
   * would make BullMQ retry against a missing key and falsely report "expired"
   * while leaving the earlier actions committed. Instead we apply what we can and
   * report exactly which succeeded and which to retry.
   */
  private async executeHeldBatch(
    actions: HeldWriteAction[],
    userId: string,
    correlationId?: string,
  ): Promise<string> {
    const booked: string[] = [];
    const moved: string[] = [];
    const failed: string[] = [];

    for (const action of actions) {
      try {
        const result = await this.executeHeldAction(action, userId);

        if (result.kind === 'booked') {
          booked.push(result.label);
        } else {
          moved.push(result.label);
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'unknown error';

        failed.push(this.heldActionLabel(action));
        this.logger.warn(
          `[cid=${correlationId ?? 'none'}] Held write failed (${action.kind} ${this.heldActionLabel(action)}): ${message}`,
        );
      }
    }

    const segments: string[] = [];

    if (booked.length > 0) {
      segments.push(`booked ${booked.join(', ')}`);
    }

    if (moved.length > 0) {
      segments.push(`moved ${moved.join(', ')}`);
    }

    if (segments.length === 0) {
      return `Sorry — I couldn't apply ${failed.join(', ')}. Please try again.`;
    }

    const done = `Done — ${segments.join('; ')}.`;

    return failed.length > 0
      ? `${done} Couldn't apply ${failed.join(', ')} — please try ${
          failed.length === 1 ? 'it' : 'those'
        } again.`
      : done;
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

    const result = await this.runToolLoop(
      user,
      conversation.id,
      params.text,
      correlationId,
    );

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
      await this.sendReply(vendorChatId, AI_FAILURE_REPLY, correlationId);

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

      const vendorMessageId = await this.sendReply(
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

    if (this.isFalseSuccessReply(replyText, committedWrites, attemptedWrites)) {
      this.logger.warn(
        `[cid=${correlationId}] Reply implies success but 0 writes committed ` +
          `(attempted=${attemptedWrites}) for user ${user.id}; sending a ` +
          `corrected reply. Original: ${JSON.stringify(replyText.slice(0, 200))}`,
      );
      replyText = CLAIM_WITHOUT_WRITE_REPLY;
    }

    const vendorMessageId = await this.sendReply(
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
   * Handles a slash command deterministically (no LLM): runs the handler, sends
   * the reply, and persists a synthetic summary line so the model stays aware of
   * what happened on the next turn (spec "Commands").
   */
  async handleCommand(user: User, params: HandleCommandParams): Promise<void> {
    const correlationId = params.correlationId ?? randomUUID();

    this.logger.log(
      `[cid=${correlationId}] command /${params.command} for user ${user.id}`,
    );

    const conversation = await this.getOrCreateConversation(user.id);
    const result = await this.commandHandler.handle(
      user,
      params.command,
      params.args,
    );

    await this.sendReply(params.vendorChatId, result.reply, correlationId);

    await this.persistMessage(
      conversation,
      ConversationMessageRole.SYNTHETIC,
      ConversationMessageContentType.COMMAND_RESULT,
      result.syntheticLine,
      null,
    );
  }

  /**
   * Resolves an inline-keyboard callback (button tap) deterministically — no
   * LLM. Acknowledges the callback, loads and burns the held write, then
   * executes or cancels it and replies (ADR 0006 layer 4).
   */
  async handleCallback(
    user: User,
    params: HandleCallbackParams,
  ): Promise<void> {
    const correlationId = params.correlationId ?? randomUUID();

    await this.vendor.acknowledgeCallback(params.callbackId);

    const conversation = await this.getOrCreateConversation(user.id);
    const [action, token] = params.callbackData.split(':') as [
      ConflictCallbackAction,
      string,
    ];

    if (!token) {
      return;
    }

    const raw = await this.redis.getdel(heldConflictKey(token));

    if (!raw) {
      this.logger.warn(
        `[cid=${correlationId}] Held conflict ${token} expired before the tap (user ${user.id})`,
      );
      await this.sendReply(
        params.vendorChatId,
        HELD_EXPIRED_REPLY,
        correlationId,
      );

      return;
    }

    const batch = JSON.parse(raw) as HeldConflictBatch;

    if (action === ConflictCallbackAction.CANCEL) {
      const cancelled = 'Cancelled — nothing was changed.';

      await this.sendReply(params.vendorChatId, cancelled, correlationId);
      await this.persistMessage(
        conversation,
        ConversationMessageRole.ASSISTANT,
        ConversationMessageContentType.TEXT,
        cancelled,
        null,
      );

      return;
    }

    const reply = await this.executeHeldBatch(
      batch.actions,
      batch.userId,
      correlationId,
    );
    const vendorMessageId = await this.sendReply(
      params.vendorChatId,
      reply,
      correlationId,
    );

    await this.persistMessage(
      conversation,
      ConversationMessageRole.ASSISTANT,
      ConversationMessageContentType.TEXT,
      reply,
      vendorMessageId,
    );
  }

  /**
   * Resumes a suspended `ask_user` turn (ADR 0010) with the user's answer — the
   * one path that DOES re-invoke the model (distinct from the deterministic
   * conflict callback above). It acknowledges a button tap, atomically claims the
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
      await this.vendor.acknowledgeCallback(params.callbackId);
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
    const result = await this.runToolLoop(
      user,
      conversation.id,
      '',
      correlationId,
      resumedRounds,
    );

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
}
