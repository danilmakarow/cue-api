import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';

import { CommandHandlerService } from './commands/command-handler.service';
import { ConflictResolverService } from './conflict/conflict-resolver.service';
import { ReplyPresenter } from './reply/reply-presenter.service';
import { ConversationStore } from './session/conversation.store';
import {
  Conversation,
  ConversationMessageContentType,
  ConversationMessageRole,
  User,
} from '@/modules/database/entities';

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
 * The assistant's deterministic, no-LLM command surface (ADR 0036). Since the
 * turn lifecycle moved down into {@link TurnRunnerService}, this is a thin facade
 * over the two paths that never run the tool loop: a slash command (run the
 * handler, reply, persist a synthetic summary line) and an ADR-0006 conflict
 * callback (delegated to the L8 {@link ConflictResolverService}). The model is
 * never re-invoked here — both paths resolve deterministically.
 */
@Injectable()
export class AssistantService {
  private readonly logger = new Logger(AssistantService.name);

  constructor(
    private readonly commandHandler: CommandHandlerService,
    private readonly conversationStore: ConversationStore,
    private readonly replyPresenter: ReplyPresenter,
    private readonly conflictResolver: ConflictResolverService,
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

    await this.replyPresenter.sendText(
      params.vendorChatId,
      result.reply,
      correlationId,
    );

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
    const conversation = await this.getOrCreateConversation(user.id);

    await this.conflictResolver.handleCallback(
      user,
      conversation,
      params,
      correlationId,
    );
  }
}
