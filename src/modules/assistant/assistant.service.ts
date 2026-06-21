import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';

import { CommandHandlerService } from './commands/command-handler.service';
import { ReplyPresenter } from './reply/reply-presenter.service';
import { ConversationStore } from './session/conversation.store';
import { StopFlagStore } from './session/stop-flag.store';
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

/** Parameters for handling a STOP-control button tap (Story 14b / ADR 0043). */
export interface HandleStopControlParams {
  callbackId: string;
  /** The in-flight turn's id (correlationId), parsed from the `stop:<turnId>` data. */
  turnId: string;
  /** Correlation id of THIS callback update (for logging); minted if absent. */
  correlationId?: string;
}

/**
 * The assistant's deterministic, no-LLM command surface (ADR 0036). Since the
 * turn lifecycle moved down into {@link TurnRunnerService}, this is a thin facade
 * over the deterministic paths that never run the tool loop: a slash command (run
 * the handler, reply, persist a synthetic summary line) and a STOP-control tap
 * (arm the per-turn STOP flag). The model is never re-invoked here. The former
 * ADR-0006 conflict-confirm callback path was removed with the deterministic hold
 * (ADR 0011 — conflicts are now resolved inside the tool loop).
 */
@Injectable()
export class AssistantService {
  private readonly logger = new Logger(AssistantService.name);

  constructor(
    private readonly commandHandler: CommandHandlerService,
    private readonly conversationStore: ConversationStore,
    private readonly replyPresenter: ReplyPresenter,
    private readonly stopFlags: StopFlagStore,
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
   * Handles a STOP-control button tap deterministically (Story 14b / ADR 0043) —
   * no LLM. Acknowledges the callback (stops the client spinner) and ARMS the
   * per-user/per-turn STOP flag keyed by the in-flight turn's id, which the running
   * turn's tool loop polls at its cooperative checkpoints (between rounds + after
   * each committed write) to halt gracefully. It does NOT touch the in-flight turn
   * directly: the running turn (under the per-user lock) keeps committed writes and
   * sends the programmatic summary itself when it next reaches a checkpoint. Both
   * the ack and the arm degrade never-throw, so a STOP tap can never break the
   * `attempts:1` callback path; an empty/garbled `turnId` simply arms nothing
   * pollable and is a harmless no-op.
   */
  async handleStopControl(
    user: User,
    params: HandleStopControlParams,
  ): Promise<void> {
    const correlationId = params.correlationId ?? randomUUID();

    this.logger.log(
      `[cid=${correlationId}] STOP tapped for turn ${params.turnId} by user ${user.id}`,
    );

    await this.replyPresenter.acknowledgeCallback(params.callbackId);

    if (!params.turnId) {
      return;
    }

    await this.stopFlags.arm(user.id, params.turnId);
  }
}
