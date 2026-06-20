import { Injectable, Logger } from '@nestjs/common';

import { HeldConflictStore } from './held-conflict.store';
import {
  ConflictCallbackAction,
  HeldRecurrence,
  HeldWriteAction,
} from '../assistant.types';
import { ReplyPresenter } from '../reply/reply-presenter.service';
import { ConversationStore } from '../session/conversation.store';
import {
  Conversation,
  ConversationMessageContentType,
  ConversationMessageRole,
  User,
} from '@/modules/database/entities';
import { CreateRecurrenceRuleDto } from '@/modules/recurrence-rule/dtos';
import {
  RecurringEditProposal,
  TaskService,
} from '@/modules/task/task.service';

/** Reply sent when a held confirmation has expired before the user tapped. */
const HELD_EXPIRED_REPLY =
  'That confirmation expired — please ask again and I will sort it out.';

/** Parameters for resolving an inline-keyboard callback (button tap). */
export interface HandleCallbackParams {
  callbackId: string;
  callbackData: string;
  vendorChatId: string;
  /** Correlation id threaded from the webhook; minted here if absent. */
  correlationId?: string;
}

/**
 * L8 conflict resolver (ADR 0006). Owns the DETERMINISTIC, no-model replay of a
 * confirmed held write: it loads/burns the held batch via {@link
 * HeldConflictStore}, executes (confirm) or drops (cancel) it through the L7
 * {@link TaskService}, and sends/persists the result via the L9 {@link
 * ReplyPresenter} + {@link ConversationStore}. The model is NEVER re-invoked
 * here — the user's button tap drives the whole path.
 */
@Injectable()
export class ConflictResolverService {
  private readonly logger = new Logger(ConflictResolverService.name);

  constructor(
    private readonly taskService: TaskService,
    private readonly heldConflictStore: HeldConflictStore,
    private readonly replyPresenter: ReplyPresenter,
    private readonly conversationStore: ConversationStore,
  ) {}

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
   * A short human-readable label for a held action, used in the failure log and
   * the "couldn't apply X" reply. Public so the orchestrator's held-prompt
   * builder (the loop side) can reuse the identical labelling.
   */
  heldActionLabel(action: HeldWriteAction): string {
    if (
      action.kind === 'create_event' ||
      action.kind === 'create_recurring_event'
    ) {
      return `"${action.title}"`;
    }

    return 'a move';
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
   * Resolves an inline-keyboard callback (button tap) deterministically — no
   * LLM. Acknowledges the callback, loads and burns the held write, then
   * executes or cancels it and replies (ADR 0006 layer 4).
   */
  async handleCallback(
    user: User,
    conversation: Conversation,
    params: HandleCallbackParams,
    correlationId: string,
  ): Promise<void> {
    await this.replyPresenter.acknowledgeCallback(params.callbackId);

    const [action, token] = params.callbackData.split(':') as [
      ConflictCallbackAction,
      string,
    ];

    if (!token) {
      return;
    }

    const batch = await this.heldConflictStore.claim(token);

    if (!batch) {
      this.logger.warn(
        `[cid=${correlationId}] Held conflict ${token} expired before the tap (user ${user.id})`,
      );
      await this.replyPresenter.sendText(
        params.vendorChatId,
        HELD_EXPIRED_REPLY,
        correlationId,
      );

      return;
    }

    if (action === ConflictCallbackAction.CANCEL) {
      const cancelled = 'Cancelled — nothing was changed.';

      await this.replyPresenter.sendText(
        params.vendorChatId,
        cancelled,
        correlationId,
      );
      await this.conversationStore.persistMessage(
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
    const vendorMessageId = await this.replyPresenter.sendText(
      params.vendorChatId,
      reply,
      correlationId,
    );

    await this.conversationStore.persistMessage(
      conversation,
      ConversationMessageRole.ASSISTANT,
      ConversationMessageContentType.TEXT,
      reply,
      vendorMessageId,
    );
  }
}
