import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { Redis } from 'ioredis';

import { AssistantConfig } from './assistant.config';
import {
  ConflictCallbackAction,
  HeldConflictWrite,
  HeldWriteAction,
  ToolDispatchContext,
} from './assistant.types';
import { MemoryExtractorService } from './background/memory-extractor.service';
import { SummarizerService } from './background/summarizer.service';
import { CommandHandlerService } from './commands/command-handler.service';
import { ContextBuilderService } from './context-builder.service';
import { HandleMap } from './tools/handle-map';
import { ToolDispatcherService } from './tools/tool-dispatcher.service';
import { SCHEDULE_FETCH_TOOLS } from './tools/tool-schemas';
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

/** The outcome of the tool-use loop for one user turn. */
type LoopOutcome =
  | { kind: 'reply'; text: string }
  | { kind: 'held'; held: HeldConflictWrite; promptText: string }
  | { kind: 'error' };

/**
 * Parameters for handling a normalized text or voice-transcript turn.
 */
export interface HandleTextParams {
  text: string;
  contentType: ConversationMessageContentType;
  vendorChatId: string;
  vendorMessageId: string | null;
}

/** Parameters for handling a deterministic slash command. */
export interface HandleCommandParams {
  command: string;
  args: string[];
  vendorChatId: string;
}

/** Parameters for resolving an inline-keyboard callback (button tap). */
export interface HandleCallbackParams {
  callbackId: string;
  callbackData: string;
  vendorChatId: string;
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
   * Sends a plain text reply, swallowing a send failure (e.g. the user blocked
   * the bot) with a log rather than crashing the turn. Returns the vendor
   * message id when the send succeeded, or null when it failed.
   */
  private async sendReply(
    vendorChatId: string,
    text: string,
  ): Promise<string | null> {
    try {
      const ref = await this.vendor.sendMessage({ vendorChatId }, { text });

      return ref.vendorMessageId;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';

      this.logger.warn(`Failed to send reply to ${vendorChatId}: ${message}`);

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
  ): Promise<LoopOutcome> {
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
    };

    const toolRounds: ToolRound[] = [];
    let scheduleFetches = 0;

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
        });

        if (
          result.stopReason !== AiStopReason.TOOL_USE ||
          !result.toolCalls?.length
        ) {
          return {
            kind: 'reply',
            text: result.text ?? ROUNDTRIP_CEILING_REPLY,
          };
        }

        const roundToolCalls = result.toolCalls;
        const roundResults: ToolRound['toolResults'] = [];

        for (const toolCall of roundToolCalls) {
          if (SCHEDULE_FETCH_TOOLS.has(toolCall.name)) {
            if (scheduleFetches >= this.config.maxScheduleFetches) {
              roundResults.push({
                toolCallId: toolCall.id,
                content: SCHEDULE_CAP_TOOL_RESULT,
                isError: false,
              });
              continue;
            }

            scheduleFetches += 1;
          }

          const outcome = await this.toolDispatcher.dispatch(
            toolCall,
            dispatchContext,
          );

          if (outcome.heldConflict) {
            return {
              kind: 'held',
              held: outcome.heldConflict.write,
              promptText: outcome.heldConflict.promptText,
            };
          }

          roundResults.push({
            toolCallId: toolCall.id,
            content: outcome.content,
            isError: outcome.isError ?? false,
          });
        }

        toolRounds.push({
          toolCalls: roundToolCalls,
          toolResults: roundResults,
          assistantText: result.text,
        });
      }

      return { kind: 'reply', text: ROUNDTRIP_CEILING_REPLY };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';

      this.logger.error(`Tool loop failed for user ${user.id}: ${message}`);

      return { kind: 'error' };
    }
  }

  /**
   * Holds a conflicting write in Redis (short TTL) and asks the user to resolve
   * it via an inline keyboard — the model is never re-invoked (ADR 0006 layer
   * 4). The user's button tap later resumes or cancels the held action.
   */
  private async holdAndAsk(
    conversation: Conversation,
    vendorChatId: string,
    held: HeldConflictWrite,
    promptText: string,
  ): Promise<void> {
    const token = randomUUID();
    const record: HeldConflictWrite = { ...held, vendorChatId };

    await this.redis.set(
      heldConflictKey(token),
      JSON.stringify(record),
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
              label: 'Book anyway',
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
   * Executes a held write deterministically after the user confirms — the
   * conflict gate is intentionally bypassed here (the user already chose to
   * proceed). Returns the reply describing what happened.
   */
  private async executeHeldWrite(
    action: HeldWriteAction,
    userId: string,
  ): Promise<string> {
    if (action.kind === 'create_event') {
      const created = await this.taskService.create(userId, {
        calendarId: action.calendarId,
        title: action.title,
        notes: action.notes ?? undefined,
        startAt: action.startAt,
        endAt: action.endAt ?? undefined,
        timezone: action.timezone,
      });

      return `Done — booked "${created.title}".`;
    }

    const updated = await this.taskService.update(userId, action.taskId, {
      startAt: action.startAt,
      endAt: action.endAt,
    });

    return `Done — moved "${updated.title}".`;
  }

  /**
   * Handles a text or voice-transcript turn end to end: persist the user turn,
   * build context, run the tool loop, then reply / hold / report a graceful
   * failure, and (on a completed reply) fire the background jobs.
   */
  async handleText(user: User, params: HandleTextParams): Promise<void> {
    const conversation = await this.getOrCreateConversation(user.id);

    await this.persistMessage(
      conversation,
      ConversationMessageRole.USER,
      params.contentType,
      params.text,
      params.vendorMessageId,
    );

    const outcome = await this.runToolLoop(user, conversation.id, params.text);

    if (outcome.kind === 'held') {
      await this.holdAndAsk(
        conversation,
        params.vendorChatId,
        outcome.held,
        outcome.promptText,
      );

      return;
    }

    const replyText =
      outcome.kind === 'error' ? AI_FAILURE_REPLY : outcome.text;
    const vendorMessageId = await this.sendReply(
      params.vendorChatId,
      replyText,
    );

    if (outcome.kind === 'error') {
      return;
    }

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
    const conversation = await this.getOrCreateConversation(user.id);
    const result = await this.commandHandler.handle(
      user,
      params.command,
      params.args,
    );

    await this.sendReply(params.vendorChatId, result.reply);

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
    await this.vendor.acknowledgeCallback(params.callbackId);

    const conversation = await this.getOrCreateConversation(user.id);
    const [action, token] = params.callbackData.split(':');

    if (!token) {
      return;
    }

    const raw = await this.redis.getdel(heldConflictKey(token));

    if (!raw) {
      await this.sendReply(params.vendorChatId, HELD_EXPIRED_REPLY);

      return;
    }

    const held = JSON.parse(raw) as HeldConflictWrite;

    if (action === ConflictCallbackAction.CANCEL) {
      const cancelled = 'Cancelled — nothing was changed.';

      await this.sendReply(params.vendorChatId, cancelled);
      await this.persistMessage(
        conversation,
        ConversationMessageRole.ASSISTANT,
        ConversationMessageContentType.TEXT,
        cancelled,
        null,
      );

      return;
    }

    const reply = await this.executeHeldWrite(held.action, held.userId);
    const vendorMessageId = await this.sendReply(params.vendorChatId, reply);

    await this.persistMessage(
      conversation,
      ConversationMessageRole.ASSISTANT,
      ConversationMessageContentType.TEXT,
      reply,
      vendorMessageId,
    );
  }
}
