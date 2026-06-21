import { Inject, Injectable, Logger } from '@nestjs/common';

import {
  CORRECTIVE_NUDGE,
  buildNarrationAuditRound,
  isCorrectionBudgetExhausted,
} from './correction-driver';
import { buildStopSummary } from './stop-summary';
import {
  ROUNDTRIP_CEILING_REPLY,
  classifyTerminalTurn,
  terminalReplyText,
} from './terminal-classifier';
import { isFalseSuccessReply, writeLedgerDelta } from './write-ledger';
import { AssistantConfig } from '../assistant.config';
import {
  AskUserOption,
  StopController,
  ToolDispatchContext,
  ToolRoundAuditPayload,
  ToolStepRecord,
  TurnStreamSink,
} from '../assistant.types';
import { RoundRecapService } from '../background/round-recap.service';
import { ContextBuilderService } from '../context-builder.service';
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
  | {
      /**
       * The user tapped STOP (Story 14b / ADR 0043): the loop hit a cooperative
       * checkpoint (between rounds or after a committed write) with the STOP flag
       * set and stopped GRACEFULLY. Committed writes are KEPT (no rollback — they
       * already happened and are not idempotent under `attempts:1`); `text` is a
       * PROGRAMMATIC summary built from the round/step ledger (NO AI call) naming
       * what was done before stopping. The orchestrator sends + persists it like a
       * normal reply. Never produced by an `ask_user` resume (no STOP control there).
       */
      kind: 'stopped';
      text: string;
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
   * Optional live-status sink (Story 13 / ADR 0041): the loop streams the final
   * round's answer text into it (the throttled status draft) and renders a
   * per-round progress recap between rounds. L9-blind — the loop only sees the
   * {@link TurnStreamSink} port; the turn runner wraps the StatusAnimation. Absent
   * ⇒ the loop runs exactly as before (no streaming, no recaps), so an
   * `ask_user` resume or a non-status turn is unaffected.
   */
  streamSink?: TurnStreamSink;
  /**
   * Optional cooperative STOP controller (Story 14b / ADR 0043): the loop polls it
   * between rounds AND after each committed write and, when it reports a STOP
   * request, stops GRACEFULLY — keeping committed writes and returning a
   * programmatic `stopped` outcome (NO AI call). L3/Redis-blind — the loop only
   * sees the {@link StopController} port; the turn runner binds it to this turn's
   * user + correlationId over the StopFlagStore. Absent ⇒ the loop never checks
   * (e.g. an `ask_user` resume, which carries no STOP control), so it runs exactly
   * as before.
   */
  stopController?: StopController;
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
    const stopController = state.stopController;
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
        // Cooperative STOP checkpoint #1 — BETWEEN rounds (Story 14b / ADR 0043).
        // Before spending another model round-trip, honour a STOP the user tapped
        // since the last round: stop gracefully, KEEP every committed write (no
        // rollback — they already happened and are not idempotent), and return a
        // PROGRAMMATIC ledger summary (NO AI call). On round 0 this is a no-op
        // unless the user somehow stopped before the first model call.
        if (await this.isStopRequested(stopController, correlationId)) {
          return this.stoppedResult(rounds, committedWrites, attemptedWrites);
        }

        // The forced tool choice (set by a corrective nudge) applies to THIS
        // round only; clear it immediately so the next round reverts to 'auto'.
        const roundToolChoice = forcedToolChoice;

        forcedToolChoice = undefined;

        // Stream the round via the connector's `completeStream` (Story 13 / ADR
        // 0041): each text delta renders into the live status draft through the
        // sink (which batches via the central draft throttle — never per-token to
        // the vendor). On a terminal round the streamed text IS the final answer,
        // already animating in the draft; the real `sendMessage` finalize (L9)
        // still persists it. `completeStream` MUST return, never throw — a stream
        // fault reconciles to a non-streamed result inside the connector — so the
        // loop's outcomes and the `attempts:1` posture are unchanged. With no sink
        // (e.g. an `ask_user` resume) the onText handler is a no-op and the round
        // behaves exactly as `complete` did.
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
            streamSink?.streamAnswer(snapshot);
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
        // Set when the cooperative STOP checkpoint fires AFTER a committed write
        // mid-round (Story 14b / ADR 0043). We finish recording THIS call's result
        // and the round's audit (so the just-committed write is in the ledger), then
        // stop before the next round — never mid-write, never with an unpaired round.
        let stoppedAfterWrite = false;

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

            // Cooperative STOP checkpoint #2 — AFTER a committed write (Story 14b /
            // ADR 0043). If this call actually committed a write and the user has
            // since tapped STOP, stop after finishing the round's audit below: the
            // committed write is KEPT (no rollback) and the remaining tool calls in
            // this round are skipped so we don't pile on more writes the user asked
            // to stop. We break (not return) so the round's audit is recorded first
            // and the just-committed write lands in the summary ledger.
            if (
              delta.committed > 0 &&
              (await this.isStopRequested(stopController, correlationId))
            ) {
              stoppedAfterWrite = true;

              break;
            }
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
          await this.renderRoundRecap(streamSink, steps, correlationId);
        }

        // STOP fired after a committed write this round (checkpoint #2): the round
        // audit is now recorded, so stop gracefully with the programmatic ledger
        // summary.
        if (stoppedAfterWrite) {
          return this.stoppedResult(rounds, committedWrites, attemptedWrites);
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
   * Polls the cooperative STOP controller (Story 14b / ADR 0043) at a checkpoint.
   * Returns false when there is no controller (e.g. an `ask_user` resume) so the
   * loop runs unchanged. NEVER throws — the controller swallows its own fault and
   * resolves false, but this also guards belt-and-braces so a STOP-flag read can
   * never abort the `attempts:1` turn path; a read fault is logged and treated as
   * "no STOP requested" (the turn simply runs to completion).
   */
  private async isStopRequested(
    stopController: StopController | undefined,
    correlationId: string,
  ): Promise<boolean> {
    if (!stopController) {
      return false;
    }

    try {
      return await stopController.isStopRequested();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';

      this.logger.debug(
        `[cid=${correlationId}] STOP checkpoint read failed; treating as no-stop: ${message}`,
      );

      return false;
    }
  }

  /**
   * Builds the `stopped` {@link ToolLoopResult} (Story 14b / ADR 0043): a graceful
   * halt that KEEPS every committed write (no rollback) and replies with a
   * PROGRAMMATIC summary built from the round/step ledger — NO AI call. The audit
   * trail (`rounds`) and the committed/attempted counters are carried through
   * unchanged so the orchestrator persists exactly what happened before the stop.
   */
  private stoppedResult(
    rounds: ToolRoundAuditPayload[],
    committedWrites: number,
    attemptedWrites: number,
  ): ToolLoopResult {
    return {
      outcome: {
        kind: 'stopped',
        text: buildStopSummary(rounds, committedWrites),
      },
      rounds,
      committedWrites,
      attemptedWrites,
    };
  }

  /**
   * Generates and renders a per-round progress recap into the live status sink
   * (Story 13 / ADR 0041). Asks the BACKGROUND model for a one-sentence "what just
   * happened" line and pushes it into the status draft. Entirely best-effort: the
   * recap service returns null on any fault (rendered as a no-op) and the sink
   * swallows its own send error, so this NEVER throws into the loop (`attempts:1`).
   */
  private async renderRoundRecap(
    streamSink: TurnStreamSink,
    steps: ToolStepRecord[],
    correlationId: string,
  ): Promise<void> {
    const recap = await this.roundRecap.recapRound(steps, correlationId);

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
