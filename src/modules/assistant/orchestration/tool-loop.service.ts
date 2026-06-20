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
  HeldConflictWrite,
  ToolDispatchContext,
  ToolRoundAuditPayload,
  ToolStepRecord,
} from '../assistant.types';
import { ConflictResolverService } from '../conflict/conflict-resolver.service';
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

/** A held conflict paired with the per-conflict prompt the dispatcher built. */
interface CollectedHeldConflict {
  write: HeldConflictWrite;
  promptText: string;
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
}

/**
 * L4 tool-loop orchestration layer (the keystone). Owns the bounded agent loop:
 * call the model; on `tool_use` dispatch each tool (enforcing the schedule-fetch
 * read cap), feed the results back, and re-invoke — until `end_turn`, a held
 * conflict, an `ask_user` suspension (ADR 0010), the narration re-drive budget
 * (ADR 0009), the round-trip ceiling, or a terminal AI error. It is vendor /
 * redis / ORM blind: it injects only the L10 {@link AiConnector}, the config, the
 * L6 {@link ContextBuilderService}, and the L5 {@link ToolDispatcherService} (plus
 * the L8 {@link ConflictResolverService} purely for the held-prompt label).
 */
@Injectable()
export class ToolLoopService {
  private readonly logger = new Logger(ToolLoopService.name);

  constructor(
    @Inject(ACTIVE_AI_CONNECTOR) private readonly ai: AiConnector,
    private readonly config: AssistantConfig,
    private readonly contextBuilder: ContextBuilderService,
    private readonly toolDispatcher: ToolDispatcherService,
    private readonly conflictResolver: ConflictResolverService,
  ) {}

  /**
   * Drives the consolidated tool-use loop for one turn. Calls the model; on
   * `tool_use` it dispatches each tool (enforcing the schedule-fetch read cap),
   * feeds the results back, and re-invokes — until `end_turn`, a held conflict,
   * the overall round-trip ceiling, or a terminal AI error.
   */
  async run(state: ToolLoopState): Promise<ToolLoopResult> {
    const { user, conversationId, currentMessageText, correlationId } = state;
    const resumeRounds = state.resumeRounds;
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
      .map((conflict) =>
        this.conflictResolver.heldActionLabel(conflict.write.action),
      )
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
