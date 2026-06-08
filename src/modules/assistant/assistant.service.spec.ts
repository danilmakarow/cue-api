import { AssistantService } from './assistant.service';
import { ConflictCallbackAction, HeldConflictWrite } from './assistant.types';
import {
  AiStopReason,
  CompletionResult,
  ToolCall,
} from '@/modules/ai/ai.types';
import {
  Conversation,
  ConversationMessageRole,
  ConversationMessageContentType,
  User,
} from '@/modules/database/entities';

/**
 * Builds a bare CompletionResult with zeroed usage, overlaid with the given
 * fields, so each test states only what it cares about.
 */
const completion = (over: Partial<CompletionResult>): CompletionResult => ({
  stopReason: AiStopReason.END_TURN,
  usage: {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  },
  ...over,
});

/** Builds a tool call with a generated id unless one is supplied. */
const toolCall = (
  name: string,
  input: Record<string, unknown> = {},
): ToolCall => ({
  id: `call-${name}-${Math.random().toString(36).slice(2, 8)}`,
  name,
  input,
});

const USER = { id: 'user-1', timezone: 'UTC', displayName: 'Tony' } as User;
const CONVERSATION = { id: 'conv-1', userId: 'user-1' } as Conversation;
const CHAT_ID = '12345';

/**
 * Assembles an AssistantService with jest mocks for every collaborator, exposing
 * the mocks so tests can program the AI connector and assert on the vendor /
 * redis / dispatcher. Defaults are the common happy path (existing conversation,
 * generous caps).
 */
const buildHarness = () => {
  const ai = { complete: jest.fn(), completeStructured: jest.fn() };
  const vendor = {
    sendMessage: jest.fn().mockResolvedValue({ vendorMessageId: 'm-1' }),
    sendActions: jest.fn().mockResolvedValue({ vendorMessageId: 'm-actions' }),
    acknowledgeCallback: jest.fn().mockResolvedValue(undefined),
  };
  const redis = { set: jest.fn().mockResolvedValue('OK'), getdel: jest.fn() };
  const config = {
    maxToolRoundtrips: 8,
    maxScheduleFetches: 5,
    heldConflictTtlSeconds: 600,
  };
  const contextBuilder = {
    build: jest.fn().mockResolvedValue({ system: [], messages: [], tools: [] }),
  };
  const toolDispatcher = { dispatch: jest.fn() };
  const commandHandler = { handle: jest.fn() };
  const summarizer = { maybeSummarize: jest.fn().mockResolvedValue(undefined) };
  const memoryExtractor = { extract: jest.fn().mockResolvedValue(undefined) };
  const taskService = { create: jest.fn(), update: jest.fn() };
  const conversationDatabaseService = {
    findByUserId: jest.fn().mockResolvedValue(CONVERSATION),
    createInstance: jest.fn((partial) => partial as Conversation),
    save: jest.fn(async (entity) => entity as Conversation),
  };
  const conversationMessageDatabaseService = {
    createInstance: jest.fn((partial) => partial),
    save: jest.fn(async (entity) => entity),
  };

  const service = new AssistantService(
    ai as never,
    vendor as never,
    redis as never,
    config as never,
    contextBuilder as never,
    toolDispatcher as never,
    commandHandler as never,
    summarizer as never,
    memoryExtractor as never,
    taskService as never,
    conversationDatabaseService as never,
    conversationMessageDatabaseService as never,
  );

  return {
    service,
    ai,
    vendor,
    redis,
    config,
    contextBuilder,
    toolDispatcher,
    summarizer,
    memoryExtractor,
    taskService,
    conversationMessageDatabaseService,
  };
};

/** Extracts the text of every persisted assistant message. */
const assistantReplies = (conversationMessageDatabaseService: {
  createInstance: jest.Mock;
}): string[] =>
  conversationMessageDatabaseService.createInstance.mock.calls
    .map(([partial]) => partial)
    .filter((partial) => partial.role === ConversationMessageRole.ASSISTANT)
    .map((partial) => partial.content);

describe('AssistantService (orchestrator)', () => {
  it('runs a tool_use round, dispatches, re-invokes, and replies on end_turn', async () => {
    const harness = buildHarness();
    const call = toolCall('list_tasks', {
      from: '2026-06-01T00:00:00Z',
      to: '2026-06-02T00:00:00Z',
    });

    harness.ai.complete
      .mockResolvedValueOnce(
        completion({ stopReason: AiStopReason.TOOL_USE, toolCalls: [call] }),
      )
      .mockResolvedValueOnce(
        completion({
          stopReason: AiStopReason.END_TURN,
          text: 'You have one event.',
        }),
      );
    harness.toolDispatcher.dispatch.mockResolvedValue({
      content: '09:00 Standup',
      countsAsScheduleFetch: true,
    });

    await harness.service.handleText(USER, {
      text: "what's on today?",
      contentType: ConversationMessageContentType.TEXT,
      vendorChatId: CHAT_ID,
      vendorMessageId: 'in-1',
    });

    expect(harness.ai.complete).toHaveBeenCalledTimes(2);
    expect(harness.toolDispatcher.dispatch).toHaveBeenCalledTimes(1);

    // The second complete call carries the completed round so the model continues.
    const secondRequest = harness.ai.complete.mock.calls[1][0];

    expect(secondRequest.toolRounds).toHaveLength(1);
    expect(secondRequest.toolRounds[0].toolResults[0]).toMatchObject({
      toolCallId: call.id,
      content: '09:00 Standup',
    });
    expect(harness.vendor.sendMessage).toHaveBeenCalledWith(
      { vendorChatId: CHAT_ID },
      { text: 'You have one event.' },
    );
  });

  it('creates one HandleMap per turn and threads the same instance into the dispatch context', async () => {
    const harness = buildHarness();
    const call = toolCall('update_task', { handle: 'e1' });

    harness.ai.complete
      .mockResolvedValueOnce(
        completion({ stopReason: AiStopReason.TOOL_USE, toolCalls: [call] }),
      )
      .mockResolvedValueOnce(
        completion({ stopReason: AiStopReason.END_TURN, text: 'Done.' }),
      );
    harness.toolDispatcher.dispatch.mockResolvedValue({ content: 'updated' });

    await harness.service.handleText(USER, {
      text: 'move the dentist',
      contentType: ConversationMessageContentType.TEXT,
      vendorChatId: CHAT_ID,
      vendorMessageId: null,
    });

    // The context builder was handed a HandleMap (it seeds the agenda into it).
    const buildInput = harness.contextBuilder.build.mock.calls[0][0];

    expect(buildInput.handleMap).toBeDefined();

    // The dispatcher received the SAME instance, so agenda-seeded handles resolve.
    const dispatchContext = harness.toolDispatcher.dispatch.mock.calls[0][1];

    expect(dispatchContext.handleMap).toBe(buildInput.handleMap);
  });

  it('threads one stable HandleMap across every tool round within a turn', async () => {
    const harness = buildHarness();

    harness.ai.complete
      .mockResolvedValueOnce(
        completion({
          stopReason: AiStopReason.TOOL_USE,
          toolCalls: [toolCall('list_tasks', { from: 'a', to: 'b' })],
        }),
      )
      .mockResolvedValueOnce(
        completion({
          stopReason: AiStopReason.TOOL_USE,
          toolCalls: [toolCall('complete_task', { handle: 'e3' })],
        }),
      )
      .mockResolvedValueOnce(
        completion({ stopReason: AiStopReason.END_TURN, text: 'Done.' }),
      );
    harness.toolDispatcher.dispatch.mockResolvedValue({ content: 'ok' });

    await harness.service.handleText(USER, {
      text: 'list today then complete one',
      contentType: ConversationMessageContentType.TEXT,
      vendorChatId: CHAT_ID,
      vendorMessageId: null,
    });

    const dispatchCalls = harness.toolDispatcher.dispatch.mock.calls;
    const firstMap = dispatchCalls[0][1].handleMap;
    const secondMap = dispatchCalls[1][1].handleMap;

    expect(firstMap).toBe(secondMap);
  });

  it('threads the SAME HandleMap from contextBuilder.build into every dispatch context (build↔dispatch identity, stable across rounds)', async () => {
    const harness = buildHarness();

    // One tool_use round, then a second tool_use round, then a final reply — so
    // we can assert the map is identical at build time AND at each dispatch, and
    // that it does not change between rounds.
    harness.ai.complete
      .mockResolvedValueOnce(
        completion({
          stopReason: AiStopReason.TOOL_USE,
          toolCalls: [toolCall('list_tasks', { from: 'a', to: 'b' })],
        }),
      )
      .mockResolvedValueOnce(
        completion({
          stopReason: AiStopReason.TOOL_USE,
          toolCalls: [toolCall('complete_task', { handle: 'e1' })],
        }),
      )
      .mockResolvedValueOnce(
        completion({ stopReason: AiStopReason.END_TURN, text: 'Done.' }),
      );
    harness.toolDispatcher.dispatch.mockResolvedValue({ content: 'ok' });

    await harness.service.handleText(USER, {
      text: 'list today then complete one',
      contentType: ConversationMessageContentType.TEXT,
      vendorChatId: CHAT_ID,
      vendorMessageId: null,
    });

    // The map the orchestrator handed the context builder to seed the agenda…
    const seededMap = harness.contextBuilder.build.mock.calls[0][0].handleMap;

    expect(seededMap).toBeDefined();

    // …is the very same instance it puts on the dispatch context for every round.
    const dispatchCalls = harness.toolDispatcher.dispatch.mock.calls;

    expect(dispatchCalls).toHaveLength(2);
    expect(dispatchCalls[0][1].handleMap).toBe(seededMap);
    expect(dispatchCalls[1][1].handleMap).toBe(seededMap);
  });

  it('passes a clarifying question (end_turn text, no tools) straight through', async () => {
    const harness = buildHarness();

    harness.ai.complete.mockResolvedValueOnce(
      completion({
        stopReason: AiStopReason.END_TURN,
        text: 'When, and how long?',
      }),
    );

    await harness.service.handleText(USER, {
      text: 'book a meeting',
      contentType: ConversationMessageContentType.TEXT,
      vendorChatId: CHAT_ID,
      vendorMessageId: null,
    });

    expect(harness.ai.complete).toHaveBeenCalledTimes(1);
    expect(harness.toolDispatcher.dispatch).not.toHaveBeenCalled();
    expect(harness.vendor.sendMessage).toHaveBeenCalledWith(
      { vendorChatId: CHAT_ID },
      { text: 'When, and how long?' },
    );
  });

  it('stops at the overall round-trip ceiling with a graceful reply', async () => {
    const harness = buildHarness();

    harness.config.maxToolRoundtrips = 3;
    // Always ask for a (non-schedule) tool so the loop never naturally ends.
    harness.ai.complete.mockResolvedValue(
      completion({
        stopReason: AiStopReason.TOOL_USE,
        toolCalls: [toolCall('delete_task', { handle: 'e1' })],
      }),
    );
    harness.toolDispatcher.dispatch.mockResolvedValue({ content: 'deleted' });

    await harness.service.handleText(USER, {
      text: 'loop forever',
      contentType: ConversationMessageContentType.TEXT,
      vendorChatId: CHAT_ID,
      vendorMessageId: null,
    });

    expect(harness.ai.complete).toHaveBeenCalledTimes(3);

    const [, reply] = harness.vendor.sendMessage.mock.calls[0];

    expect(reply.text).toMatch(/more steps than i can take/i);
  });

  it('caps schedule fetches per turn and refuses the 6th with a note', async () => {
    const harness = buildHarness();

    harness.config.maxScheduleFetches = 5;
    harness.config.maxToolRoundtrips = 20;

    let round = 0;

    harness.ai.complete.mockImplementation(() => {
      round += 1;

      if (round <= 6) {
        return Promise.resolve(
          completion({
            stopReason: AiStopReason.TOOL_USE,
            toolCalls: [toolCall('list_tasks', { from: 'a', to: 'b' })],
          }),
        );
      }

      return Promise.resolve(
        completion({ stopReason: AiStopReason.END_TURN, text: 'done' }),
      );
    });
    harness.toolDispatcher.dispatch.mockResolvedValue({
      content: 'events',
      countsAsScheduleFetch: true,
    });

    await harness.service.handleText(USER, {
      text: 'check many days',
      contentType: ConversationMessageContentType.TEXT,
      vendorChatId: CHAT_ID,
      vendorMessageId: null,
    });

    // Only 5 fetches actually dispatched; the 6th is refused without dispatch.
    expect(harness.toolDispatcher.dispatch).toHaveBeenCalledTimes(5);

    const sixthRoundRequest = harness.ai.complete.mock.calls[6][0];
    const lastRound =
      sixthRoundRequest.toolRounds[sixthRoundRequest.toolRounds.length - 1];

    expect(lastRound.toolResults[0].content).toMatch(
      /schedule-fetch limit reached/i,
    );
  });

  it('holds a conflicting write, asks via inline keyboard, and does NOT re-invoke the model', async () => {
    const harness = buildHarness();
    const held: HeldConflictWrite = {
      userId: USER.id,
      vendorChatId: '',
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

    harness.ai.complete.mockResolvedValueOnce(
      completion({
        stopReason: AiStopReason.TOOL_USE,
        toolCalls: [toolCall('create_event')],
      }),
    );
    harness.toolDispatcher.dispatch.mockResolvedValue({
      content: 'held',
      heldConflict: {
        promptText: 'That overlaps with Lunch. Book anyway?',
        write: held,
      },
    });

    await harness.service.handleText(USER, {
      text: 'book dentist at 3',
      contentType: ConversationMessageContentType.TEXT,
      vendorChatId: CHAT_ID,
      vendorMessageId: null,
    });

    // Model called exactly once — not re-invoked to resolve the conflict.
    expect(harness.ai.complete).toHaveBeenCalledTimes(1);
    expect(harness.vendor.sendMessage).not.toHaveBeenCalled();
    expect(harness.vendor.sendActions).toHaveBeenCalledTimes(1);
    // The held write is stashed in Redis with the real chat id injected.
    expect(harness.redis.set).toHaveBeenCalled();

    const [, payload] = harness.redis.set.mock.calls[0];

    expect(JSON.parse(payload)).toMatchObject({ vendorChatId: CHAT_ID });
  });

  it('resumes a held write on the confirm callback and writes deterministically', async () => {
    const harness = buildHarness();
    const held: HeldConflictWrite = {
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

  it('replies gracefully and persists nothing extra when the AI errors terminally', async () => {
    const harness = buildHarness();

    harness.ai.complete.mockRejectedValueOnce(new Error('429 from provider'));

    await harness.service.handleText(USER, {
      text: 'hello',
      contentType: ConversationMessageContentType.TEXT,
      vendorChatId: CHAT_ID,
      vendorMessageId: null,
    });

    const [, reply] = harness.vendor.sendMessage.mock.calls[0];

    expect(reply.text).toMatch(/having trouble/i);
    // No assistant turn persisted on a terminal error (only the user turn).
    expect(
      assistantReplies(harness.conversationMessageDatabaseService),
    ).toHaveLength(0);
    expect(harness.summarizer.maybeSummarize).not.toHaveBeenCalled();
  });

  it('does NOT abort the batch on the first held conflict — commits the rest and holds all conflicts together', async () => {
    const harness = buildHarness();
    const heldWrite: HeldConflictWrite = {
      userId: USER.id,
      vendorChatId: '',
      action: {
        kind: 'create_event',
        calendarId: 'cal-1',
        title: 'Lesson 2',
        startAt: '2026-06-13T08:00:00Z',
        endAt: '2026-06-13T11:00:00Z',
        timezone: 'UTC',
        notes: null,
      },
    };

    // One round emitting three create_task calls; the middle one conflicts.
    harness.ai.complete.mockResolvedValueOnce(
      completion({
        stopReason: AiStopReason.TOOL_USE,
        toolCalls: [
          toolCall('create_task', { title: 'Lesson 1' }),
          toolCall('create_task', { title: 'Lesson 2' }),
          toolCall('create_task', { title: 'Lesson 3' }),
        ],
      }),
    );
    harness.toolDispatcher.dispatch
      .mockResolvedValueOnce({ content: 'Created "Lesson 1".' })
      .mockResolvedValueOnce({
        content: 'held',
        heldConflict: {
          promptText: 'That overlaps with Tennis. Book anyway?',
          write: heldWrite,
        },
      })
      .mockResolvedValueOnce({ content: 'Created "Lesson 3".' });

    await harness.service.handleText(USER, {
      text: 'create three lessons',
      contentType: ConversationMessageContentType.TEXT,
      vendorChatId: CHAT_ID,
      vendorMessageId: null,
    });

    // All three calls were dispatched — the conflict did not short-circuit.
    expect(harness.toolDispatcher.dispatch).toHaveBeenCalledTimes(3);
    // The model was not re-invoked to resolve the conflict.
    expect(harness.ai.complete).toHaveBeenCalledTimes(1);
    // One held write stashed, with the 2 committed writes reported in the prompt.
    expect(harness.vendor.sendActions).toHaveBeenCalledTimes(1);

    const [, actions] = harness.vendor.sendActions.mock.calls[0];

    expect(actions.text).toMatch(/saved 2 changes/i);
    expect(actions.buttons[0][0].label).toMatch(/book anyway/i);

    const [, payload] = harness.redis.set.mock.calls[0];

    expect(JSON.parse(payload).actions).toHaveLength(1);
  });

  it('refuses to confirm a mutation the model only narrated (no write committed)', async () => {
    const harness = buildHarness();

    // The model ends its turn claiming it created events but calls no tool.
    harness.ai.complete.mockResolvedValueOnce(
      completion({
        stopReason: AiStopReason.END_TURN,
        text: 'Создаю все семь в группе Driving Lessons.',
      }),
    );

    await harness.service.handleText(USER, {
      text: 'create the seven lessons',
      contentType: ConversationMessageContentType.TEXT,
      vendorChatId: CHAT_ID,
      vendorMessageId: null,
    });

    expect(harness.toolDispatcher.dispatch).not.toHaveBeenCalled();

    const [, reply] = harness.vendor.sendMessage.mock.calls[0];

    // The false success is replaced with an honest "nothing changed" reply.
    expect(reply.text).not.toMatch(/Создаю/);
    expect(reply.text).toMatch(/nothing was changed|didn't .* save/i);
    // And the corrected text is what gets persisted, not the model's claim.
    expect(
      assistantReplies(harness.conversationMessageDatabaseService),
    ).toEqual([expect.stringMatching(/nothing was changed|didn't .* save/i)]);
  });

  it('keeps a genuine success reply when a write actually committed', async () => {
    const harness = buildHarness();

    harness.ai.complete
      .mockResolvedValueOnce(
        completion({
          stopReason: AiStopReason.TOOL_USE,
          toolCalls: [toolCall('create_task', { title: 'Lesson' })],
        }),
      )
      .mockResolvedValueOnce(
        completion({
          stopReason: AiStopReason.END_TURN,
          text: 'Created your lesson.',
        }),
      );
    harness.toolDispatcher.dispatch.mockResolvedValue({
      content: 'Created "Lesson".',
    });

    await harness.service.handleText(USER, {
      text: 'create a lesson',
      contentType: ConversationMessageContentType.TEXT,
      vendorChatId: CHAT_ID,
      vendorMessageId: null,
    });

    const [, reply] = harness.vendor.sendMessage.mock.calls[0];

    expect(reply.text).toBe('Created your lesson.');
  });

  it('overrides a success claim when a write was attempted but errored (no veto)', async () => {
    const harness = buildHarness();

    harness.ai.complete
      .mockResolvedValueOnce(
        completion({
          stopReason: AiStopReason.TOOL_USE,
          toolCalls: [toolCall('create_task', { title: 'Lesson' })],
        }),
      )
      .mockResolvedValueOnce(
        completion({
          stopReason: AiStopReason.END_TURN,
          text: 'All done — I added your lesson.',
        }),
      );
    // The write was ATTEMPTED but failed.
    harness.toolDispatcher.dispatch.mockResolvedValue({
      content: 'Error: invalid time',
      isError: true,
    });

    await harness.service.handleText(USER, {
      text: 'create a lesson',
      contentType: ConversationMessageContentType.TEXT,
      vendorChatId: CHAT_ID,
      vendorMessageId: null,
    });

    const [, reply] = harness.vendor.sendMessage.mock.calls[0];

    expect(reply.text).not.toMatch(/added your lesson/i);
    expect(reply.text).toMatch(/nothing was changed|didn't .* save/i);
  });

  it('keeps an HONEST failure reply (negation veto) even when the write errored', async () => {
    const harness = buildHarness();

    harness.ai.complete
      .mockResolvedValueOnce(
        completion({
          stopReason: AiStopReason.TOOL_USE,
          toolCalls: [toolCall('create_task', { title: 'Lesson' })],
        }),
      )
      .mockResolvedValueOnce(
        completion({
          stopReason: AiStopReason.END_TURN,
          text: "I couldn't add that — the time was invalid.",
        }),
      );
    harness.toolDispatcher.dispatch.mockResolvedValue({
      content: 'Error: invalid time',
      isError: true,
    });

    await harness.service.handleText(USER, {
      text: 'create a lesson',
      contentType: ConversationMessageContentType.TEXT,
      vendorChatId: CHAT_ID,
      vendorMessageId: null,
    });

    const [, reply] = harness.vendor.sendMessage.mock.calls[0];

    // The model already told the truth — do not clobber it.
    expect(reply.text).toBe("I couldn't add that — the time was invalid.");
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
