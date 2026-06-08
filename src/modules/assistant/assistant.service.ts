import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { Redis } from 'ioredis';

import { AssistantConfig } from './assistant.config';
import {
  ConflictCallbackAction,
  HeldConflictBatch,
  HeldConflictWrite,
  HeldWriteAction,
  ToolDispatchContext,
  ToolRoundAuditPayload,
  ToolStepRecord,
} from './assistant.types';
import { MemoryExtractorService } from './background/memory-extractor.service';
import { SummarizerService } from './background/summarizer.service';
import { CommandHandlerService } from './commands/command-handler.service';
import { ContextBuilderService } from './context-builder.service';
import { HandleMap } from './tools/handle-map';
import { ToolDispatcherService } from './tools/tool-dispatcher.service';
import { SCHEDULE_FETCH_TOOLS, WRITE_TOOLS } from './tools/tool-schemas';
import { heldConflictKey } from '../redis/redis.constants';
import { REDIS_CLIENT } from '../redis/redis.module';
import { AiConnector } from '@/modules/ai/ai-connector.abstract';
import { ACTIVE_AI_CONNECTOR } from '@/modules/ai/ai.module';
import { AiModelRole, AiStopReason, ToolRound } from '@/modules/ai/ai.types';
import {
  Conversation,
  ConversationMessageContentType,
  ConversationMessageRole,
  User,
} from '@/modules/database/entities';
import {
  ConversationDatabaseService,
  ConversationMessageDatabaseService,
} from '@/modules/database/services';
import { ExternalVendorConnector } from '@/modules/external-vendor/external-vendor-connector.abstract';
import { ACTIVE_VENDOR_CONNECTOR } from '@/modules/external-vendor/external-vendor.module';
import { TaskService } from '@/modules/task/task.service';

/** Reply sent when the AI fails after its bounded retries (spec error table). */
const AI_FAILURE_REPLY =
  "I'm having trouble reaching my reasoning just now — try again in a moment.";

/** Reply sent when a turn hits the overall tool round-trip ceiling. */
const ROUNDTRIP_CEILING_REPLY =
  'That took more steps than I can take in one go — could you narrow it down a little?';

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
 * Detects the model asserting *its own* calendar mutation (EN + RU). Anchored to
 * a first-person subject for English ("I created / I've booked / added it") and
 * to first-person verb stems for Russian (which drops the pronoun: "Создаю…",
 * "добавил"). Used only as the *positive* half — a {@link CLAIM_VETO_PATTERN}
 * match always overrides it, and it is consulted only when the model made no
 * write attempt at all (the pure-narration trap). Reporting an existing booking
 * ("the cancelled meeting was Friday") is not first-person and does not match.
 */
const MUTATION_CLAIM_PATTERN =
  /\bI(?:['’]ve|['’]ll|['’]m| have| just| will| already)?\s+(?:created|added|booked|scheduled|saved|set up|moved|rescheduled|updated|deleted|removed|cancell?ed|put (?:it|that|them))\b|\b(?:created|added|booked|scheduled|moved|saved|updated|rescheduled|deleted|removed|cancell?ed) (?:it|them|that|your)\b|созда(?:л|ю|м|ла)|добав(?:ил|лю|ляю|ила)|запис(?:ал|ала)|запланир(?:овал|ую)|перенёс|перенесл[аи]?|перенесу|обнов(?:ил|лю)|удал(?:ил|ю|ила)|сохран(?:ил|ю)/iu;

/**
 * Vetoes a mutation "claim" that is actually a non-action: a negation ("nothing
 * was deleted", "I couldn't add"), a report of existing state ("already
 * booked"), or an offer/question ("want me to add?", trailing "?"). When this
 * matches we never override the reply — the model is being honest, or asking.
 */
const CLAIM_VETO_PATTERN =
  /\b(?:not|n['’]t|nothing|never|already|unable|cannot|can['’]t|couldn['’]t|could not|won['’]t|would not|didn['’]t|don['’]t|no longer|want me to|shall i|should i|would you like)\b|(?:^|[\s,])(?:не|ни|ничего|нельзя|уже|хочешь|хотите)(?=[\s,.!?]|$)|не удалось|не получилось|\?\s*$/iu;

/** The outcome of the tool-use loop for one user turn. */
type LoopOutcome =
  | { kind: 'reply'; text: string }
  | { kind: 'held'; held: HeldConflictWrite[]; promptText: string }
  | { kind: 'error' };

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
  ): Promise<ToolLoopResult> {
    // One HandleMap per user turn: the context builder seeds it with an alias
    // per rendered agenda occurrence, and the SAME instance threads into every
    // tool-loop dispatch so those handles resolve when the model later mutates a
    // task. Aliases keep counting up within the turn (the dispatcher's list_tasks
    // appends to it) and stay stable across rounds.
    const handleMap = new HandleMap();
    const prompt = await this.contextBuilder.build({
      user,
      conversationId,
      currentMessageText,
      handleMap,
    });
    const dispatchContext: ToolDispatchContext = {
      userId: user.id,
      user,
      handleMap,
      correlationId,
    };

    const toolRounds: ToolRound[] = [];
    const rounds: ToolRoundAuditPayload[] = [];
    let scheduleFetches = 0;
    let committedWrites = 0;
    let attemptedWrites = 0;

    try {
      for (
        let roundtrip = 0;
        roundtrip < this.config.maxToolRoundtrips;
        roundtrip += 1
      ) {
        const result = await this.ai.complete({
          modelRole: AiModelRole.MAIN,
          system: prompt.system,
          messages: prompt.messages,
          tools: prompt.tools,
          toolRounds,
          features: { promptCaching: true, contextEditing: true },
          traceId: correlationId,
        });

        if (
          result.stopReason !== AiStopReason.TOOL_USE ||
          !result.toolCalls?.length
        ) {
          return {
            outcome: {
              kind: 'reply',
              text: result.text ?? ROUNDTRIP_CEILING_REPLY,
            },
            rounds,
            committedWrites,
            attemptedWrites,
          };
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

          // A held conflict no longer aborts the batch (failure mode #2): record
          // it, hand the model a benign tool result, and keep dispatching the
          // rest of the round — non-conflicting writes still commit. All collected
          // conflicts are confirmed together after the round.
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

          if (WRITE_TOOLS.has(toolCall.name)) {
            attemptedWrites += 1;

            if (!isError) {
              committedWrites += 1;
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
        conflict.write.action.kind === 'create_event'
          ? `"${conflict.write.action.title}"`
          : 'a move',
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
   * Fires the post-turn background jobs (rolling summary + memory extraction)
   * without blocking the reply (ADR 0005). Each job catches its own errors.
   */
  private triggerBackgroundJobs(conversationId: string, userId: string): void {
    void this.summarizer.maybeSummarize(conversationId);
    void this.memoryExtractor.extract(conversationId, userId);
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
      const label =
        action.kind === 'create_event' ? `"${action.title}"` : 'a move';

      try {
        if (action.kind === 'create_event') {
          const created = await this.taskService.create(userId, {
            calendarId: action.calendarId,
            title: action.title,
            notes: action.notes ?? undefined,
            startAt: action.startAt,
            endAt: action.endAt ?? undefined,
            timezone: action.timezone,
          });

          booked.push(`"${created.title}"`);
          continue;
        }

        const updated = await this.taskService.update(userId, action.taskId, {
          startAt: action.startAt,
          endAt: action.endAt,
        });

        moved.push(`"${updated.title}"`);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'unknown error';

        failed.push(label);
        this.logger.warn(
          `[cid=${correlationId ?? 'none'}] Held write failed (${action.kind} ${label}): ${message}`,
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

    const { outcome, rounds, committedWrites, attemptedWrites } =
      await this.runToolLoop(user, conversation.id, params.text, correlationId);

    // Persist the tool-loop audit trail regardless of how the turn ended.
    await this.persistToolRounds(conversation.id, rounds);

    if (outcome.kind === 'held') {
      await this.holdAndAsk(
        conversation,
        params.vendorChatId,
        outcome.held,
        outcome.promptText,
      );

      return;
    }

    if (outcome.kind === 'error') {
      await this.sendReply(
        params.vendorChatId,
        AI_FAILURE_REPLY,
        correlationId,
      );

      return;
    }

    // Guard (failure mode #1): the reply sounds like success but nothing actually
    // committed — refuse to confirm an action that never happened, and flag it.
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
      params.vendorChatId,
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
}
