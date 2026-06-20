import { ConflictResolverService } from './conflict-resolver.service';
import { HeldConflictStore } from './held-conflict.store';
import { AssistantService } from '../assistant.service';
import { ConflictCallbackAction } from '../assistant.types';
import { ReplyPresenter } from '../reply/reply-presenter.service';
import { ConversationStore } from '../session/conversation.store';
import { Conversation, User } from '@/modules/database/entities';

const USER = { id: 'user-1', timezone: 'UTC', displayName: 'Tony' } as User;
const CONVERSATION = { id: 'conv-1', userId: 'user-1' } as Conversation;
const CHAT_ID = '12345';

/**
 * Assembles the deterministic ADR-0006 conflict-callback path with jest mocks for
 * every collaborator, exposing the mocks so tests can program the held batch
 * (redis.getdel) and assert on the vendor / taskService. The callback enters
 * through the thin {@link AssistantService} facade — which loads the conversation
 * and delegates to the L8 {@link ConflictResolverService} — wrapped around REAL
 * store / presenter instances so every existing redis.getdel, taskService.*, and
 * vendor.* assertion observes the identical calls through the layers.
 */
const buildHarness = () => {
  const vendor = {
    sendMessage: jest.fn().mockResolvedValue({ vendorMessageId: 'm-1' }),
    sendActions: jest.fn().mockResolvedValue({ vendorMessageId: 'm-actions' }),
    acknowledgeCallback: jest.fn().mockResolvedValue(undefined),
  };
  const ai = { complete: jest.fn(), completeStructured: jest.fn() };
  const redis = { set: jest.fn().mockResolvedValue('OK'), getdel: jest.fn() };
  const config = {
    heldConflictTtlSeconds: 600,
  };
  const taskService = {
    create: jest.fn(),
    update: jest.fn(),
    splitSeries: jest.fn(),
  };
  const conversationDatabaseService = {
    findByUserId: jest.fn().mockResolvedValue(CONVERSATION),
    createInstance: jest.fn((partial) => partial as Conversation),
    save: jest.fn(async (entity) => entity as Conversation),
  };
  const conversationMessageDatabaseService = {
    createInstance: jest.fn((partial) => partial),
    save: jest.fn(async (entity) => entity),
  };
  const conversationStore = new ConversationStore(
    conversationDatabaseService as never,
    conversationMessageDatabaseService as never,
  );
  const replyPresenter = new ReplyPresenter(vendor as never);
  const heldConflictStore = new HeldConflictStore(
    redis as never,
    config as never,
  );
  const conflictResolver = new ConflictResolverService(
    taskService as never,
    heldConflictStore,
    replyPresenter,
    conversationStore,
  );
  // The thin command-surface facade (ADR 0036). `handleCallback` loads the
  // conversation and delegates to the conflict resolver — the consumer's entry
  // point. The commandHandler is unused on this path.
  const service = new AssistantService(
    { handle: jest.fn() } as never,
    conversationStore as never,
    replyPresenter as never,
    conflictResolver as never,
  );

  return {
    service,
    ai,
    vendor,
    redis,
    config,
    taskService,
    conversationMessageDatabaseService,
  };
};

describe('ConflictResolverService (ADR 0006 deterministic callback)', () => {
  it('resumes a held write on the confirm callback and writes deterministically', async () => {
    const harness = buildHarness();
    const held = {
      userId: USER.id,
      vendorChatId: CHAT_ID,
      action: {
        kind: 'create_event',
        calendarId: 'cal-1',
        title: 'Dentist',
        startAt: '2026-06-02T15:00:00Z',
        endAt: '2026-06-02T16:00:00Z',
        timezone: 'UTC',
        notes: null,
      },
    };

    harness.redis.getdel.mockResolvedValue(
      JSON.stringify({
        userId: held.userId,
        vendorChatId: held.vendorChatId,
        actions: [held.action],
      }),
    );
    harness.taskService.create.mockResolvedValue({
      id: 't-1',
      title: 'Dentist',
    });

    await harness.service.handleCallback(USER, {
      callbackId: 'cb-1',
      callbackData: `${ConflictCallbackAction.CONFIRM}:token-1`,
      vendorChatId: CHAT_ID,
    });

    expect(harness.vendor.acknowledgeCallback).toHaveBeenCalledWith('cb-1');
    expect(harness.taskService.create).toHaveBeenCalledTimes(1);
    expect(harness.ai.complete).not.toHaveBeenCalled();

    const [, reply] = harness.vendor.sendMessage.mock.calls[0];

    expect(reply.text).toMatch(/booked/i);
  });

  it('executes a confirmed held recurring CREATE verbatim, with its recurrence (Story 9)', async () => {
    const harness = buildHarness();

    harness.redis.getdel.mockResolvedValue(
      JSON.stringify({
        userId: USER.id,
        vendorChatId: CHAT_ID,
        actions: [
          {
            kind: 'create_recurring_event',
            calendarId: 'cal-1',
            title: 'Standup',
            startAt: '2026-06-10T09:00:00Z',
            endAt: '2026-06-10T09:15:00Z',
            timezone: 'UTC',
            notes: null,
            groupId: null,
            isAllDay: false,
            requiresCompletion: true,
            recurrence: { frequency: 'WEEKLY', byWeekday: [0, 1, 2, 3, 4] },
          },
        ],
      }),
    );
    harness.taskService.create.mockResolvedValue({
      id: 't-1',
      title: 'Standup',
    });

    await harness.service.handleCallback(USER, {
      callbackId: 'cb-r1',
      callbackData: `${ConflictCallbackAction.CONFIRM}:token-r1`,
      vendorChatId: CHAT_ID,
    });

    expect(harness.taskService.create).toHaveBeenCalledTimes(1);

    // The recurrence rides along verbatim — the series is created, not silently
    // dropped, with the conflict check bypassed (the user chose "book anyway").
    const createArg = harness.taskService.create.mock.calls[0][1];

    expect(createArg.recurrence).toMatchObject({
      frequency: 'WEEKLY',
      byWeekday: [0, 1, 2, 3, 4],
    });
    expect(harness.ai.complete).not.toHaveBeenCalled();

    const [, reply] = harness.vendor.sendMessage.mock.calls[0];

    expect(reply.text).toMatch(/booked/i);
  });

  it('executes a confirmed held recurring EDIT at its chosen scope (Story 9)', async () => {
    const harness = buildHarness();

    harness.redis.getdel.mockResolvedValue(
      JSON.stringify({
        userId: USER.id,
        vendorChatId: CHAT_ID,
        actions: [
          {
            kind: 'update_recurring_event',
            taskId: 't-1',
            editScope: 'this_and_following',
            originalStart: '2026-06-10T09:00:00.000Z',
            title: null,
            startAt: '2026-06-10T10:00:00Z',
            endAt: '2026-06-10T10:30:00Z',
            groupId: null,
            recurrence: null,
          },
        ],
      }),
    );
    harness.taskService.splitSeries.mockResolvedValue({
      id: 't-2',
      title: 'Standup',
    });

    await harness.service.handleCallback(USER, {
      callbackId: 'cb-r2',
      callbackData: `${ConflictCallbackAction.CONFIRM}:token-r2`,
      vendorChatId: CHAT_ID,
    });

    // The chosen scope (this_and_following) replays as a splitSeries call with
    // the held coordinate + changes — never a plain master update.
    expect(harness.taskService.splitSeries).toHaveBeenCalledTimes(1);
    expect(harness.taskService.update).not.toHaveBeenCalled();

    const [, taskId, , changes] = harness.taskService.splitSeries.mock.calls[0];

    expect(taskId).toBe('t-1');
    expect(changes).toMatchObject({
      startAt: '2026-06-10T10:00:00Z',
      endAt: '2026-06-10T10:30:00Z',
    });

    const [, reply] = harness.vendor.sendMessage.mock.calls[0];

    expect(reply.text).toMatch(/moved/i);
  });

  it('cancels a held write on the cancel callback without writing', async () => {
    const harness = buildHarness();

    harness.redis.getdel.mockResolvedValue(
      JSON.stringify({
        userId: USER.id,
        vendorChatId: CHAT_ID,
        actions: [
          {
            kind: 'update_event',
            taskId: 't-1',
            startAt: 'a',
            endAt: null,
          },
        ],
      }),
    );

    await harness.service.handleCallback(USER, {
      callbackId: 'cb-2',
      callbackData: `${ConflictCallbackAction.CANCEL}:token-2`,
      vendorChatId: CHAT_ID,
    });

    expect(harness.taskService.update).not.toHaveBeenCalled();

    const [, reply] = harness.vendor.sendMessage.mock.calls[0];

    expect(reply.text).toMatch(/cancelled/i);
  });

  it('applies what it can and reports failures when one held action throws (no rethrow, no retry)', async () => {
    const harness = buildHarness();

    harness.redis.getdel.mockResolvedValue(
      JSON.stringify({
        userId: USER.id,
        vendorChatId: CHAT_ID,
        actions: [
          {
            kind: 'create_event',
            calendarId: 'cal-1',
            title: 'Lesson A',
            startAt: '2026-06-13T08:00:00Z',
            endAt: '2026-06-13T11:00:00Z',
            timezone: 'UTC',
            notes: null,
          },
          {
            kind: 'create_event',
            calendarId: 'cal-1',
            title: 'Lesson B',
            startAt: '2026-06-14T08:00:00Z',
            endAt: '2026-06-14T11:00:00Z',
            timezone: 'UTC',
            notes: null,
          },
        ],
      }),
    );
    harness.taskService.create
      .mockResolvedValueOnce({ id: 't-a', title: 'Lesson A' })
      .mockRejectedValueOnce(new Error('calendar gone'));

    // Must not throw, so the BullMQ job never retries against the burned token.
    await expect(
      harness.service.handleCallback(USER, {
        callbackId: 'cb-3',
        callbackData: `${ConflictCallbackAction.CONFIRM}:token-3`,
        vendorChatId: CHAT_ID,
      }),
    ).resolves.toBeUndefined();

    expect(harness.taskService.create).toHaveBeenCalledTimes(2);

    const [, reply] = harness.vendor.sendMessage.mock.calls[0];

    // Honest partial result: what succeeded AND what to retry.
    expect(reply.text).toMatch(/booked "Lesson A"/);
    expect(reply.text).toMatch(/couldn't apply "Lesson B"/i);
  });
});
