import { Inject, Injectable, Logger } from '@nestjs/common';

import {
  CORRECTIVE_NUDGE,
  buildNarrationAuditRound,
  isCorrectionBudgetExhausted,
} from './correction-driver';
import {
  ROUNDTRIP_CEILING_REPLY,
  classifyTerminalTurn,
  terminalReplyText,
} from './terminal-classifier';
import { isFalseSuccessReply, writeLedgerDelta } from './write-ledger';
import { AssistantConfig } from '../assistant.config';
import {
  AskUserOption,
  ToolDispatchContext,
  ToolRoundAuditPayload,
  ToolStepRecord,
  TurnStreamSink,
} from '../assistant.types';
import { RoundRecapService } from '../background/round-recap.service';
import { ContextBuilderService } from '../context-builder.service';
import { StatusLocale } from '../reply/status-phrases';
import { HandleMap } from '../tools/handle-map';
import { ToolDispatcherService } from '../tools/tool-dispatcher.service';
import { SCHEDULE_FETCH_TOOLS, WRITE_TOOLS } from '../tools/tool-registry';
import { AiConnector } from '@/modules/ai/ai-connector.abstract';
import { ACTIVE_AI_CONNECTOR } from '@/modules/ai/ai.module';
import {
  AiModelRole,
  AiToolChoice,
  PromptBlock,
  PromptRole,
  ToolRound,
} from '@/modules/ai/ai.types';
import { User } from '@/modules/database/entities';

/** Tool result returned once the per-turn schedule-fetch cap is reached. */
const SCHEDULE_CAP_TOOL_RESULT =
  'Schedule-fetch limit reached for this turn; proceed with the information already gathered.';

/**
 * The suspended session of an `ask_user` turn (ADR 0010), carried on the `ask`
 * {@link LoopOutcome} so the orchestrator can persist + mirror it and resume on
 * the user's answer. `toolRounds` are the accumulated rounds INCLUDING the
 * assistant round that holds the `ask_user` `tool_use` but deliberately NOT its
 * `tool_result` (the wire invariant — synthesized on resume against
 * {@link askToolUseId}). The same shape feeds {@link PendingQuestionPayload}.
 */
export interface AskSuspension {
  toolRounds: ToolRound[];
  askToolUseId: string;
  question: string;
  optionLabels: AskUserOption[];
}

/** The outcome of the tool-use loop for one user turn. */
export type LoopOutcome =
  | { kind: 'reply'; text: string }
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
 * The full result of one tool-use loop: the user-facing {@link LoopOutcome}, the
 * per-round audit trail to persist, and how many writes actually committed (so
 * the caller can refuse to claim success when none did).
 */
export interface ToolLoopResult {
  outcome: LoopOutcome;
  rounds: ToolRoundAuditPayload[];
  /** Write tools that committed (non-error, non-held) — the saved-changes count. */
  committedWrites: number;
  /** Write tools dispatched this turn (committed or errored) — for the guard. */
  attemptedWrites: number;
}

/**
 * The inputs that seed one tool-use loop run. A fresh turn supplies the user, the
 * conversation id, the current message text, and the correlation id; an
 * `ask_user` RESUME (ADR 0010) additionally supplies `resumeRounds` to rehydrate
 * the suspended turn's accumulated rounds.
 */
export interface ToolLoopState {
  user: User;
  conversationId: string;
  currentMessageText: string;
  correlationId: string;
  resumeRounds?: ToolRound[];
  /**
   * The turn's resolved loading-status locale (R2 / ADR 0055): the language the
   * per-round recaps are written in. Threaded down to {@link RoundRecapService} so
   * the BACKGROUND recap model is told to write in the user's language. Absent ⇒
   * the recap defaults to English (the prior behaviour), so a turn whose language
   * never resolved is unaffected.
   */
  recapLocale?: StatusLocale;
  /**
   * Optional live-status sink (Story 13 / ADR 0041): the loop streams the final
   * round's answer text into it (the throttled status draft) and renders a
   * per-round progress recap between rounds. L9-blind — the loop only sees the
   * {@link TurnStreamSink} port; the turn runner wraps the StatusAnimation. Absent
   * ⇒ the loop runs exactly as before (no streaming, no recaps), so an
   * `ask_user` resume or a non-status turn is unaffected.
   */
  streamSink?: TurnStreamSink;
}

/**
 * L4 tool-loop orchestration layer (the keystone). Owns the bounded agent loop:
 * call the model; on `tool_use` dispatch each tool (enforcing the schedule-fetch
 * read cap), feed the results back, and re-invoke — until `end_turn`, an
 * `ask_user` suspension (ADR 0010), the narration re-drive budget (ADR 0009), the
 * round-trip ceiling, or a terminal AI error. A conflicting write is just a
 * recoverable `isError` tool result (ADR 0011 default-deny) the model recovers
 * from in-loop — no separate hold outcome. It is vendor / redis / ORM blind: it
 * injects only the L10 {@link AiConnector}, the config, the L6
 * {@link ContextBuilderService}, and the L5 {@link ToolDispatcherService}.
 */
@Injectable()
export class ToolLoopService {
  private readonly logger = new Logger(ToolLoopService.name);

  constructor(
    @Inject(ACTIVE_AI_CONNECTOR) private readonly ai: AiConnector,
    private readonly config: AssistantConfig,
    private readonly contextBuilder: ContextBuilderService,
    private readonly toolDispatcher: ToolDispatcherService,
    private readonly roundRecap: RoundRecapService,
  ) {}

  /**
   * Drives the consolidated tool-use loop for one turn. Calls the model; on
   * `tool_use` it dispatches each tool (enforcing the schedule-fetch read cap),
   * feeds the results back, and re-invokes — until `end_turn`, an `ask_user`
   * suspension, the overall round-trip ceiling, or a terminal AI error.
   */
  async run(state: ToolLoopState): Promise<ToolLoopResult> {
    const { user, conversationId, currentMessageText, correlationId } = state;
    const resumeRounds = state.resumeRounds;
    const streamSink = state.streamSink;
    const recapLocale = state.recapLocale;
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
        // The standing conflict policy (Story 15 / ADR 0011 + 0044), resolved once
        // in the context build and threaded here so the dispatcher's conflict gate
        // honours an explicit allow/deny without a model round-trip — sharing the
        // same value restated to the model in the now-context.
        conflictPolicy: prompt.conflictPolicy ?? undefined,
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

        // Drive the round via the connector's `completeStream` (Story 13 / ADR
        // 0041). R3 / ADR 0058 RE-ENABLES answer token streaming (reversing the
        // ADR-0052 no-op): we forward each round's accumulated answer SNAPSHOT to
        // the stream sink's `onToken`, which renders it into the live morph message
        // (throttled in L9). We forward on EVERY round — a round that ends in
        // `tool_use` has its streamed text reconciled by the per-round recap (which
        // overwrites the streamed line), and the terminal answer round's streamed
        // text becomes the answer the L9 morph then re-formats. `completeStream`
        // MUST return, never throw — a stream fault reconciles to a non-streamed
        // result inside the connector — so the loop's outcomes and the `attempts:1`
        // posture hold regardless of how the round resolves.
        const result = await this.ai.completeStream(
          {
            modelRole: AiModelRole.MAIN,
            system: prompt.system,
            messages,
            tools: prompt.tools,
            toolRounds,
            toolChoice: roundToolChoice,
            features: { promptCaching: true, contextEditing: true },
            traceId: correlationId,
          },
          (_delta, snapshot) => {
            // Forward the accumulated answer text to the live morph message; the
            // sink throttles/coalesces and swallows its own fault (degrade-never
            // -throw), so a status fault never disturbs the turn (ADR 0058).
            streamSink?.onToken?.(snapshot);
          },
        );

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
          const classification = classifyTerminalTurn(
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
                text: terminalReplyText(result.stopReason, result.text),
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
          if (
            isCorrectionBudgetExhausted(corrections, this.config.maxCorrections)
          ) {
            // maxCorrections === 0 is the kill-switch: return the model's text
            // as a normal reply so the existing isFalseSuccessReply guard masks
            // it (today's detect-and-mask behaviour, unchanged).
            if (this.config.maxCorrections === 0) {
              return {
                outcome: {
                  kind: 'reply',
                  text: terminalReplyText(result.stopReason, result.text),
                },
                rounds,
                committedWrites,
                attemptedWrites,
              };
            }

            // Budget exhausted with re-drive enabled: escalate honestly.
            rounds.push(
              buildNarrationAuditRound(
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
            buildNarrationAuditRound(
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

          // A write that overlaps an existing commitment comes back as an ordinary
          // recoverable `isError` result (ADR 0011 default-deny) — the dispatcher
          // restates the clash and the model recovers in-loop (asks the user or
          // retries with `confirmOverlap`). No separate hold channel; it is fed
          // back like any other tool result below.
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
            held: false,
          });

          // Write accounting: a batch tool supplies its own committed/attempted
          // counts; a single-write tool omits them, so fall back to today's exact
          // per-call +1 (one attempt; one commit unless it errored). Non-write
          // tools touch neither counter.
          if (WRITE_TOOLS.has(toolCall.name)) {
            const delta = writeLedgerDelta(
              outcome.attemptedCount,
              outcome.committedCount,
              isError,
            );

            attemptedWrites += delta.attempted;
            committedWrites += delta.committed;
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

        // Per-round progress recap (Story 13 / ADR 0041): a one-sentence BACKGROUND
        // (Haiku) summary of what this round just did, rendered into the status
        // draft so the user sees progress before the next round. Best-effort +
        // degrade-never-throw — `recapRound` returns null on any fault and the sink
        // swallows its own send fault. Skipped when there's no live status sink.
        if (streamSink) {
          await this.renderRoundRecap(
            streamSink,
            steps,
            correlationId,
            recapLocale,
          );
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
   * Generates and renders a per-round progress recap into the live status sink
   * (Story 13 / ADR 0041). Asks the BACKGROUND model for a one-sentence "what just
   * happened" line, in the user's language (`recapLocale`, R2 / ADR 0055; English
   * when absent), and pushes it into the status draft. Entirely best-effort: the
   * recap service returns null on any fault (rendered as a no-op) and the sink
   * swallows its own send error, so this NEVER throws into the loop (`attempts:1`).
   */
  private async renderRoundRecap(
    streamSink: TurnStreamSink,
    steps: ToolStepRecord[],
    correlationId: string,
    recapLocale: StatusLocale | undefined,
  ): Promise<void> {
    const recap = await this.roundRecap.recapRound(
      steps,
      correlationId,
      recapLocale,
    );

    if (recap) {
      streamSink.showRecap(recap);
    }
  }

  /**
   * Decides whether a reply falsely claims success and must be replaced (failure
   * mode #1). Thin delegation to the L4 {@link isFalseSuccessReply} write-ledger
   * helper — the single source of the claim/veto patterns. Public so the
   * orchestrator's post-loop guard reuses the identical detection through this
   * service without duplicating the patterns.
   */
  isFalseSuccessReply(
    text: string,
    committedWrites: number,
    attemptedWrites: number,
  ): boolean {
    return isFalseSuccessReply(text, committedWrites, attemptedWrites);
  }
}
