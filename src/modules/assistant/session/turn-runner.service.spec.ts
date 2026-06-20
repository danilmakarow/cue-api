import { ConversationStore } from './conversation.store';
import { TurnAuditStore } from './turn-audit.store';
import { TurnRunnerService } from './turn-runner.service';
import { HeldConflictWrite } from '../assistant.types';
import { ConflictResolverService } from '../conflict/conflict-resolver.service';
import { HeldConflictStore } from '../conflict/held-conflict.store';
import { ToolLoopService } from '../orchestration/tool-loop.service';
import { ReplyPresenter } from '../reply/reply-presenter.service';
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
 * Assembles a TurnRunnerService with jest mocks for every collaborator, exposing
 * the mocks so tests can program the AI connector and assert on the vendor /
 * redis / dispatcher. Defaults are the common happy path (existing conversation,
 * generous caps). REAL layer instances (stores, presenter, conflict resolver,
 * tool loop) wrap the same DB-service / vendor / redis mocks so every assertion
 * observes the identical persistence + send + loop calls through the new layers.
 */
const buildHarness = () => {
  const ai = { complete: jest.fn(), completeStructured: jest.fn() };
  const vendor = {
    sendMessage: jest.fn().mockResolvedValue({ vendorMessageId: 'm-1' }),
    sendActions: jest.fn().mockResolvedValue({ vendorMessageId: 'm-actions' }),
    acknowledgeCallback: jest.fn().mockResolvedValue(undefined),
  };
  const alert = { capture: jest.fn() };
  const redis = { set: jest.fn().mockResolvedValue('OK'), getdel: jest.fn() };
  const config = {
    maxToolRoundtrips: 8,
    maxScheduleFetches: 5,
    maxCorrections: 5,
    heldConflictTtlSeconds: 600,
  };
  const contextBuilder = {
    build: jest.fn().mockResolvedValue({ system: [], messages: [], tools: [] }),
  };
  const toolDispatcher = { dispatch: jest.fn() };
  const summarizer = { maybeSummarize: jest.fn().mockResolvedValue(undefined) };
  const memoryExtractor = { extract: jest.fn().mockResolvedValue(undefined) };
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
  // Story 8: conversation/audit persistence now lives in dedicated L3 stores.
  // The turn runner delegates to these; we wrap REAL store instances around the
  // same DB-service mocks so every existing createInstance/save assertion (and
  // the `assistantReplies` helper) observes the identical persistence calls.
  const conversationStore = new ConversationStore(
    conversationDatabaseService as never,
    conversationMessageDatabaseService as never,
  );
  const turnAuditStore = new TurnAuditStore(
    conversationMessageDatabaseService as never,
  );
  // The pending-interaction write side (ADR 0010). Defaults are inert: no open
  // question, every claim misses — so the existing non-ask suites are unaffected.
  const pendingInteraction = {
    hasPendingQuestion: jest.fn().mockResolvedValue(false),
    createPendingQuestion: jest
      .fn()
      .mockResolvedValue({ id: 'pq-1', payload: { optionLabels: [] } }),
    claimById: jest.fn().mockResolvedValue(null),
    claimHotByUser: jest.fn().mockResolvedValue(null),
  };
  // Story 8 (L9 reply/egress): the turn runner no longer holds the vendor
  // connector — it delegates every send to the ReplyPresenter, the sole caller of
  // vendor.sendMessage/sendActions/acknowledgeCallback. We wrap a REAL presenter
  // around the same vendor mock so every existing vendor.* assertion observes the
  // identical send calls (text, keyboards, callback acks) through the new layer.
  const replyPresenter = new ReplyPresenter(vendor as never);
  // Story 8 (L8 conflict layer, ADR 0006): the deterministic held-conflict state
  // + replay now live in dedicated providers. We wrap REAL instances around the
  // same redis / config / taskService / replyPresenter / conversationStore mocks
  // so every existing redis.set/getdel, taskService.*, and vendor.* assertion
  // observes the identical calls through the new layer — no assertion changes.
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
  // Story 8 (L4 tool-loop, the keystone): the agent loop now lives in a dedicated
  // ToolLoopService. We wrap a REAL instance around the same ai / config /
  // contextBuilder / toolDispatcher / conflictResolver mocks so every existing
  // ai.complete, contextBuilder.build, and toolDispatcher.dispatch assertion
  // observes the identical loop calls through the new layer — no assertion changes.
  const toolLoop = new ToolLoopService(
    ai as never,
    config as never,
    contextBuilder as never,
    toolDispatcher as never,
    conflictResolver,
  );

  // Story 8 (L3 turn runner, ADR 0036): the turn lifecycle now OWNS handleText /
  // resumeAnswer / finishTurn + the held-hold + ask-suspend tail. The runner is
  // assembled around the same REAL layer instances + mocks above so every
  // assertion below observes the identical persistence / send / loop calls.
  const service = new TurnRunnerService(
    alert as never,
    toolLoop as never,
    summarizer as never,
    memoryExtractor as never,
    conversationStore as never,
    turnAuditStore as never,
    pendingInteraction as never,
    replyPresenter as never,
    heldConflictStore as never,
  );

  return {
    service,
    ai,
    vendor,
    alert,
    redis,
    config,
    contextBuilder,
    toolDispatcher,
    summarizer,
    memoryExtractor,
    taskService,
    conversationMessageDatabaseService,
    pendingInteraction,
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

describe('TurnRunnerService (turn lifecycle)', () => {
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

    // The map the runner handed the context builder to seed the agenda…
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

  it('dispatches tool calls carried under a non-TOOL_USE stop reason (e.g. MAX_TOKENS)', async () => {
    const harness = buildHarness();
    const call = toolCall('create_task', { title: 'Lesson' });

    // The model is cut off (MAX_TOKENS) mid tool-call burst but still emitted a
    // tool_use block — gating on content (not stop reason) means it must run.
    harness.ai.complete
      .mockResolvedValueOnce(
        completion({ stopReason: AiStopReason.MAX_TOKENS, toolCalls: [call] }),
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

    expect(harness.toolDispatcher.dispatch).toHaveBeenCalledTimes(1);

    const [, reply] = harness.vendor.sendMessage.mock.calls[0];

    expect(reply.text).toBe('Created your lesson.');
  });

  it('sends an honest truncated reply (not the fragment) on a no-tool MAX_TOKENS terminal', async () => {
    const harness = buildHarness();

    // No tool calls, stopped on MAX_TOKENS: the text we hold is a cut-off
    // fragment, so we must not relay it as if it were the complete answer.
    harness.ai.complete.mockResolvedValueOnce(
      completion({
        stopReason: AiStopReason.MAX_TOKENS,
        text: 'Here is the very long agenda that got cut off mid-sen',
      }),
    );

    await harness.service.handleText(USER, {
      text: 'summarize my whole month',
      contentType: ConversationMessageContentType.TEXT,
      vendorChatId: CHAT_ID,
      vendorMessageId: null,
    });

    const [, reply] = harness.vendor.sendMessage.mock.calls[0];

    expect(reply.text).not.toMatch(/cut off mid-sen/);
    expect(reply.text).toMatch(/cut that short/i);
    // The honest reply is what gets persisted, not the truncated fragment.
    expect(
      assistantReplies(harness.conversationMessageDatabaseService),
    ).toEqual([expect.stringMatching(/cut that short/i)]);
  });

  it('sends an honest decline on a REFUSAL terminal instead of relaying refusal text', async () => {
    const harness = buildHarness();

    harness.ai.complete.mockResolvedValueOnce(
      completion({
        stopReason: AiStopReason.REFUSAL,
        text: 'I cannot continue with this request.',
      }),
    );

    await harness.service.handleText(USER, {
      text: 'do something disallowed',
      contentType: ConversationMessageContentType.TEXT,
      vendorChatId: CHAT_ID,
      vendorMessageId: null,
    });

    const [, reply] = harness.vendor.sendMessage.mock.calls[0];

    expect(reply.text).toMatch(/not able to help/i);
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

  it('replies gracefully (does not propagate) when context assembly throws', async () => {
    const harness = buildHarness();

    // A build failure (rolling summary / agenda read throws) is now inside the
    // tool-loop try, so it degrades to AI_FAILURE_REPLY instead of escaping
    // handleText — every inbound turn must produce a user-facing reply.
    harness.contextBuilder.build.mockRejectedValueOnce(
      new Error('summary store unreachable'),
    );

    await expect(
      harness.service.handleText(USER, {
        text: 'hello',
        contentType: ConversationMessageContentType.TEXT,
        vendorChatId: CHAT_ID,
        vendorMessageId: null,
      }),
    ).resolves.toBeUndefined();

    // The model was never even reached.
    expect(harness.ai.complete).not.toHaveBeenCalled();

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

  it('counts every committed item of a create_tasks batch toward committedWrites (saved N changes)', async () => {
    const harness = buildHarness();

    // Round 0: the model issues ONE create_tasks call for three lessons; round 1
    // would normally be the terminal reply, but here a held conflict from the
    // batch ends the turn first so we can read the committed count off the
    // held-confirmation prompt ("Saved N changes").
    harness.ai.complete.mockResolvedValueOnce(
      completion({
        stopReason: AiStopReason.TOOL_USE,
        toolCalls: [
          toolCall('create_tasks', {
            tasks: [
              { title: 'Lesson 1' },
              { title: 'Lesson 2' },
              { title: 'Lesson 3' },
            ],
          }),
        ],
      }),
    );
    // The batch tool returns ONE outcome: 2 committed, 1 held.
    harness.toolDispatcher.dispatch.mockResolvedValueOnce({
      content:
        '1: created "Lesson 1"; 2: held (overlaps Tennis); 3: created "Lesson 3"',
      committedCount: 2,
      attemptedCount: 3,
      heldConflicts: [
        {
          promptText: 'That overlaps with Tennis. Shall I book it anyway?',
          write: {
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
          },
        },
      ],
    });

    await harness.service.handleText(USER, {
      text: 'create three lessons',
      contentType: ConversationMessageContentType.TEXT,
      vendorChatId: CHAT_ID,
      vendorMessageId: null,
    });

    // One model call (the batch is a single tool call) and one dispatch.
    expect(harness.ai.complete).toHaveBeenCalledTimes(1);
    expect(harness.toolDispatcher.dispatch).toHaveBeenCalledTimes(1);

    // The held item routes into the batch-hold confirmation, and the 2 committed
    // items from the SAME batch are reported as saved changes.
    expect(harness.vendor.sendActions).toHaveBeenCalledTimes(1);

    const [, actions] = harness.vendor.sendActions.mock.calls[0];

    expect(actions.text).toMatch(/saved 2 changes/i);

    // Only the single held write is stashed for confirmation.
    const [, payload] = harness.redis.set.mock.calls[0];

    expect(JSON.parse(payload).actions).toHaveLength(1);
  });

  it('treats a fully-committed create_tasks batch as genuine — no re-drive, real reply sent', async () => {
    const harness = buildHarness();

    // Round 0: ONE create_tasks call. Round 1: terminal success reply. Because
    // the batch committed writes, the terminal turn is genuine — the success
    // narration is NOT masked and the model is NOT re-driven.
    harness.ai.complete
      .mockResolvedValueOnce(
        completion({
          stopReason: AiStopReason.TOOL_USE,
          toolCalls: [
            toolCall('create_tasks', {
              tasks: [{ title: 'Lesson 1' }, { title: 'Lesson 2' }],
            }),
          ],
        }),
      )
      .mockResolvedValueOnce(
        completion({
          stopReason: AiStopReason.END_TURN,
          text: 'Создал оба урока.',
        }),
      );
    harness.toolDispatcher.dispatch.mockResolvedValueOnce({
      content: '1: created "Lesson 1"; 2: created "Lesson 2"',
      committedCount: 2,
      attemptedCount: 2,
    });

    await harness.service.handleText(USER, {
      text: 'create two lessons',
      contentType: ConversationMessageContentType.TEXT,
      vendorChatId: CHAT_ID,
      vendorMessageId: null,
    });

    // Tool round then terminal — no forced re-drive round.
    expect(harness.ai.complete).toHaveBeenCalledTimes(2);
    expect(harness.toolDispatcher.dispatch).toHaveBeenCalledTimes(1);
    expect(harness.alert.capture).not.toHaveBeenCalled();
    // No tool choice was ever forced (committedWrites > 0 ⇒ genuine).
    expect(harness.ai.complete.mock.calls[1][0].toolChoice).toBeUndefined();

    const [, reply] = harness.vendor.sendMessage.mock.calls[0];

    // The genuine success reply is sent verbatim, NOT masked as a false success.
    expect(reply.text).toBe('Создал оба урока.');
  });

  it('kill-switch (ASSISTANT_MAX_CORRECTIONS=0): masks a narrated mutation instead of re-driving', async () => {
    const harness = buildHarness();

    // Kill-switch on: re-drive disabled, today's detect-and-mask guard restored.
    harness.config.maxCorrections = 0;

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

    // No re-drive: the model was called exactly once and no tools dispatched.
    expect(harness.ai.complete).toHaveBeenCalledTimes(1);
    expect(harness.toolDispatcher.dispatch).not.toHaveBeenCalled();
    expect(harness.alert.capture).not.toHaveBeenCalled();

    const [, reply] = harness.vendor.sendMessage.mock.calls[0];

    // The false success is replaced with an honest "nothing changed" reply.
    expect(reply.text).not.toMatch(/Создаю/);
    expect(reply.text).toMatch(/nothing was changed|didn't .* save/i);
    // And the corrected text is what gets persisted, not the model's claim.
    expect(
      assistantReplies(harness.conversationMessageDatabaseService),
    ).toEqual([expect.stringMatching(/nothing was changed|didn't .* save/i)]);
  });

  it('re-drives a narrated mutation exactly once with tool_choice:any, then sends the success reply when it commits', async () => {
    const harness = buildHarness();

    // Round 0: pure narration, zero tools. Round 1 (re-driven): the model now
    // calls create_task. Round 2: terminal success reply.
    harness.ai.complete
      .mockResolvedValueOnce(
        completion({
          stopReason: AiStopReason.END_TURN,
          text: 'Создаю все семь в группе Driving Lessons.',
        }),
      )
      .mockResolvedValueOnce(
        completion({
          stopReason: AiStopReason.TOOL_USE,
          toolCalls: [toolCall('create_task', { title: 'Lesson 1' })],
        }),
      )
      .mockResolvedValueOnce(
        completion({
          stopReason: AiStopReason.END_TURN,
          text: 'Done — created all seven.',
        }),
      );
    harness.toolDispatcher.dispatch.mockResolvedValue({
      content: 'Created "Lesson 1".',
    });

    await harness.service.handleText(USER, {
      text: 'create the seven lessons',
      contentType: ConversationMessageContentType.TEXT,
      vendorChatId: CHAT_ID,
      vendorMessageId: null,
    });

    // Three model calls: narration → forced re-drive → terminal.
    expect(harness.ai.complete).toHaveBeenCalledTimes(3);

    // The re-driven round (the 2nd call) forced a tool call.
    expect(harness.ai.complete.mock.calls[1][0].toolChoice).toBe('any');
    // The narration round (1st) and terminal round (3rd) did NOT force a choice.
    expect(harness.ai.complete.mock.calls[0][0].toolChoice).toBeUndefined();
    expect(harness.ai.complete.mock.calls[2][0].toolChoice).toBeUndefined();

    // The corrective USER nudge was appended to the volatile message tail.
    const reDriveMessages = harness.ai.complete.mock.calls[1][0].messages;
    const lastMessage = reDriveMessages[reDriveMessages.length - 1];

    expect(lastMessage.role).toBe('user');
    expect(lastMessage.content).toMatch(/called no tools/i);

    // The write committed, so the genuine success reply is sent (not masked).
    expect(harness.toolDispatcher.dispatch).toHaveBeenCalledTimes(1);
    expect(harness.alert.capture).not.toHaveBeenCalled();

    const [, reply] = harness.vendor.sendMessage.mock.calls[0];

    expect(reply.text).toBe('Done — created all seven.');
  });

  it('does not force a tool call on the round AFTER a re-drive (forced choice is one round only)', async () => {
    const harness = buildHarness();

    // Narration → re-drive (forced) → the model STILL narrates with no tools →
    // a second re-drive (forced again). The round between the two re-drives must
    // not carry a stale forced choice. We assert the per-round choice pattern.
    harness.ai.complete
      .mockResolvedValueOnce(
        completion({
          stopReason: AiStopReason.END_TURN,
          text: 'Adding it to your calendar.',
        }),
      )
      .mockResolvedValueOnce(
        completion({
          stopReason: AiStopReason.END_TURN,
          text: 'Saving it now.',
        }),
      )
      .mockResolvedValueOnce(
        completion({
          stopReason: AiStopReason.TOOL_USE,
          toolCalls: [toolCall('create_task', { title: 'X' })],
        }),
      )
      .mockResolvedValueOnce(
        completion({ stopReason: AiStopReason.END_TURN, text: 'Done.' }),
      );
    harness.toolDispatcher.dispatch.mockResolvedValue({ content: 'Created.' });

    await harness.service.handleText(USER, {
      text: 'add it',
      contentType: ConversationMessageContentType.TEXT,
      vendorChatId: CHAT_ID,
      vendorMessageId: null,
    });

    const choices = harness.ai.complete.mock.calls.map(
      (call) => call[0].toolChoice,
    );

    // Round 0: no force. Round 1: forced (after 1st narration). Round 2: forced
    // (after 2nd narration). Round 3 (the tool round was 2; this terminal) none.
    expect(choices[0]).toBeUndefined();
    expect(choices[1]).toBe('any');
    expect(choices[2]).toBe('any');
  });

  it('escalates to unresolved (honest reply + alert, no throw) when the correction budget is exhausted', async () => {
    const harness = buildHarness();

    harness.config.maxCorrections = 2;
    harness.config.maxToolRoundtrips = 8;

    // The model narrates a write every single round and never calls a tool, so
    // each re-drive fails to commit and the budget is spent.
    harness.ai.complete.mockResolvedValue(
      completion({
        stopReason: AiStopReason.END_TURN,
        text: 'Создаю все семь.',
      }),
    );

    // Must resolve (never throw) — the BullMQ queue is attempts:1.
    await expect(
      harness.service.handleText(USER, {
        text: 'create the seven lessons',
        contentType: ConversationMessageContentType.TEXT,
        vendorChatId: CHAT_ID,
        vendorMessageId: null,
      }),
    ).resolves.toBeUndefined();

    // Round 0 (narration) + 2 corrections = 3 model calls; the 3rd hits the cap.
    expect(harness.ai.complete).toHaveBeenCalledTimes(3);
    expect(harness.toolDispatcher.dispatch).not.toHaveBeenCalled();

    // A structured escalation event was fired with the spent-budget context.
    expect(harness.alert.capture).toHaveBeenCalledTimes(1);

    const event = harness.alert.capture.mock.calls[0][0];

    expect(event.name).toBe('assistant.correction_exhausted');
    expect(event.context.corrections).toBe(2);

    // The user gets an honest "nothing was saved" reply, and it is persisted.
    const [, reply] = harness.vendor.sendMessage.mock.calls[0];

    expect(reply.text).toMatch(/nothing was saved|wasn't able to make/i);
    expect(
      assistantReplies(harness.conversationMessageDatabaseService),
    ).toEqual([
      expect.stringMatching(/nothing was saved|wasn't able to make/i),
    ]);
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

  it('kill-switch: overrides a success claim when a write was attempted but errored (no veto)', async () => {
    const harness = buildHarness();

    // Kill-switch: the errored-write narration is masked (not re-driven).
    harness.config.maxCorrections = 0;

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

  it('suspends the turn on ask_user: writes a pending question, sends the question, persists it, and does NOT re-invoke the model', async () => {
    const harness = buildHarness();
    const askCall = toolCall('ask_user', { question: 'When works for you?' });

    // One round: the model calls ask_user. The dispatcher returns the askUser
    // SENTINEL (no DB touched by the tool itself — the runner suspends).
    harness.ai.complete.mockResolvedValueOnce(
      completion({ stopReason: AiStopReason.TOOL_USE, toolCalls: [askCall] }),
    );
    harness.toolDispatcher.dispatch.mockResolvedValue({
      content: 'Asked the user; the turn is suspended pending their answer.',
      askUser: { question: 'When works for you?', options: [] },
    });

    await harness.service.handleText(USER, {
      text: 'book me a slot',
      contentType: ConversationMessageContentType.TEXT,
      vendorChatId: CHAT_ID,
      vendorMessageId: null,
    });

    // The model was called exactly once — the turn suspended, not re-driven.
    expect(harness.ai.complete).toHaveBeenCalledTimes(1);

    // A durable pending question was written, carrying the suspended session:
    // the ask tool-use id and the toolRounds INCLUDING the ask round.
    expect(
      harness.pendingInteraction.createPendingQuestion,
    ).toHaveBeenCalledTimes(1);

    const [userId, draft] =
      harness.pendingInteraction.createPendingQuestion.mock.calls[0];

    expect(userId).toBe(USER.id);
    expect(draft.askToolUseId).toBe(askCall.id);
    expect(draft.payload.question).toBe('When works for you?');
    // The suspended round carries the ask tool_use but NOT its tool_result.
    expect(draft.payload.toolRounds).toHaveLength(1);
    expect(draft.payload.toolRounds[0].toolCalls[0].id).toBe(askCall.id);
    expect(
      draft.payload.toolRounds[0].toolResults.some(
        (result: { toolCallId: string }) => result.toolCallId === askCall.id,
      ),
    ).toBe(false);

    // No options ⇒ plain text question sent (no keyboard), and persisted.
    expect(harness.vendor.sendMessage).toHaveBeenCalledWith(
      { vendorChatId: CHAT_ID },
      { text: 'When works for you?' },
    );
    expect(harness.vendor.sendActions).not.toHaveBeenCalled();
    expect(
      assistantReplies(harness.conversationMessageDatabaseService),
    ).toEqual(['When works for you?']);
  });

  it('sends an inline keyboard with ask:<pendingId>:<optId> callback data when options are present', async () => {
    const harness = buildHarness();

    harness.pendingInteraction.createPendingQuestion.mockResolvedValueOnce({
      id: 'pq-77',
      payload: { optionLabels: [] },
    });
    harness.ai.complete.mockResolvedValueOnce(
      completion({
        stopReason: AiStopReason.TOOL_USE,
        toolCalls: [toolCall('ask_user', { question: 'Which day?' })],
      }),
    );
    harness.toolDispatcher.dispatch.mockResolvedValue({
      content: 'suspended',
      askUser: {
        question: 'Which day?',
        options: [
          { id: 'fri', label: 'Friday' },
          { id: 'sat', label: 'Saturday' },
        ],
      },
    });

    await harness.service.handleText(USER, {
      text: 'when should I book it?',
      contentType: ConversationMessageContentType.TEXT,
      vendorChatId: CHAT_ID,
      vendorMessageId: null,
    });

    expect(harness.vendor.sendActions).toHaveBeenCalledTimes(1);
    expect(harness.vendor.sendMessage).not.toHaveBeenCalled();

    const [, actions] = harness.vendor.sendActions.mock.calls[0];

    expect(actions.text).toBe('Which day?');
    expect(actions.buttons[0]).toEqual([
      { label: 'Friday', callbackData: 'ask:pq-77:fri' },
      { label: 'Saturday', callbackData: 'ask:pq-77:sat' },
    ]);
  });

  it('resumes on a button tap: claims the row, feeds back ONE synthetic tool_result, and re-invokes the model', async () => {
    const harness = buildHarness();

    // The suspended session: one round with the ask tool_use, no tool_result yet.
    harness.pendingInteraction.claimById.mockResolvedValueOnce({
      id: 'pq-1',
      askToolUseId: 'ask-tuid',
      payload: {
        question: 'Which day?',
        optionLabels: [
          { id: 'fri', label: 'Friday' },
          { id: 'sat', label: 'Saturday' },
        ],
        toolRounds: [
          {
            toolCalls: [{ id: 'ask-tuid', name: 'ask_user', input: {} }],
            toolResults: [],
            assistantText: undefined,
          },
        ],
        correlationId: 'cid-1',
        vendorChatId: CHAT_ID,
      },
    });

    // On resume the model finishes the turn with a plain reply.
    harness.ai.complete.mockResolvedValueOnce(
      completion({ stopReason: AiStopReason.END_TURN, text: 'Booked Friday.' }),
    );

    await harness.service.resumeAnswer(USER, {
      source: 'callback',
      text: 'ask:pq-1:fri',
      contentType: ConversationMessageContentType.TEXT,
      vendorChatId: CHAT_ID,
      callbackId: 'cb-1',
    });

    // The button is acknowledged and the named row is claimed by id.
    expect(harness.vendor.acknowledgeCallback).toHaveBeenCalledWith('cb-1');
    expect(harness.pendingInteraction.claimById).toHaveBeenCalledWith(
      USER.id,
      'pq-1',
    );

    // The model was re-invoked with the suspended round + EXACTLY ONE synthetic
    // tool_result, paired to the ask tool-use id, carrying the chosen LABEL.
    expect(harness.ai.complete).toHaveBeenCalledTimes(1);

    const request = harness.ai.complete.mock.calls[0][0];

    expect(request.toolRounds).toHaveLength(1);

    const askRoundResults = request.toolRounds[0].toolResults;

    expect(askRoundResults).toHaveLength(1);
    expect(askRoundResults[0]).toEqual({
      toolCallId: 'ask-tuid',
      content: 'Friday',
    });

    // The continued reply is sent.
    expect(harness.vendor.sendMessage).toHaveBeenCalledWith(
      { vendorChatId: CHAT_ID },
      { text: 'Booked Friday.' },
    );
  });

  it('resumes on a free-text answer in the hot window: claims by user and feeds back the raw text', async () => {
    const harness = buildHarness();

    harness.pendingInteraction.claimHotByUser.mockResolvedValueOnce({
      id: 'pq-2',
      askToolUseId: 'ask-tuid-2',
      payload: {
        question: 'What time?',
        optionLabels: [],
        toolRounds: [
          {
            toolCalls: [{ id: 'ask-tuid-2', name: 'ask_user', input: {} }],
            toolResults: [],
          },
        ],
        correlationId: 'cid-2',
        vendorChatId: CHAT_ID,
      },
    });
    harness.ai.complete.mockResolvedValueOnce(
      completion({ stopReason: AiStopReason.END_TURN, text: 'Got it — 3pm.' }),
    );

    await harness.service.resumeAnswer(USER, {
      source: 'text',
      text: 'around 3pm',
      contentType: ConversationMessageContentType.TEXT,
      vendorChatId: CHAT_ID,
      callbackId: null,
    });

    // Free text claims the hot window (no callback ack).
    expect(harness.vendor.acknowledgeCallback).not.toHaveBeenCalled();
    expect(harness.pendingInteraction.claimHotByUser).toHaveBeenCalledWith(
      USER.id,
    );

    const request = harness.ai.complete.mock.calls[0][0];

    // Exactly one synthetic tool_result carrying the RAW text.
    expect(request.toolRounds[0].toolResults).toEqual([
      { toolCallId: 'ask-tuid-2', content: 'around 3pm' },
    ]);
    expect(harness.vendor.sendMessage).toHaveBeenCalledWith(
      { vendorChatId: CHAT_ID },
      { text: 'Got it — 3pm.' },
    );
  });

  it('ignores a resume gracefully when the claim misses (already answered / window lapsed) — no model call', async () => {
    const harness = buildHarness();

    // Default claims resolve null (no claimable row).
    await harness.service.resumeAnswer(USER, {
      source: 'callback',
      text: 'ask:pq-gone:fri',
      contentType: ConversationMessageContentType.TEXT,
      vendorChatId: CHAT_ID,
      callbackId: 'cb-9',
    });

    // The callback is still acknowledged (stop the spinner), but nothing resumes.
    expect(harness.vendor.acknowledgeCallback).toHaveBeenCalledWith('cb-9');
    expect(harness.ai.complete).not.toHaveBeenCalled();
    expect(harness.vendor.sendMessage).not.toHaveBeenCalled();
  });

  it('can suspend AGAIN on resume when the model asks a follow-up ask_user question', async () => {
    const harness = buildHarness();

    harness.pendingInteraction.claimById.mockResolvedValueOnce({
      id: 'pq-3',
      askToolUseId: 'ask-tuid-3',
      payload: {
        question: 'Which day?',
        optionLabels: [{ id: 'fri', label: 'Friday' }],
        toolRounds: [
          {
            toolCalls: [{ id: 'ask-tuid-3', name: 'ask_user', input: {} }],
            toolResults: [],
          },
        ],
        correlationId: 'cid-3',
        vendorChatId: CHAT_ID,
      },
    });
    harness.pendingInteraction.createPendingQuestion.mockResolvedValueOnce({
      id: 'pq-4',
      payload: { optionLabels: [] },
    });

    // On resume the model asks a SECOND clarifying question (suspends again).
    harness.ai.complete.mockResolvedValueOnce(
      completion({
        stopReason: AiStopReason.TOOL_USE,
        toolCalls: [toolCall('ask_user', { question: 'Morning or evening?' })],
      }),
    );
    harness.toolDispatcher.dispatch.mockResolvedValue({
      content: 'suspended again',
      askUser: { question: 'Morning or evening?', options: [] },
    });

    await harness.service.resumeAnswer(USER, {
      source: 'callback',
      text: 'ask:pq-3:fri',
      contentType: ConversationMessageContentType.TEXT,
      vendorChatId: CHAT_ID,
      callbackId: 'cb-3',
    });

    // A second pending question is written and the follow-up is sent.
    expect(
      harness.pendingInteraction.createPendingQuestion,
    ).toHaveBeenCalledTimes(1);
    expect(harness.vendor.sendMessage).toHaveBeenCalledWith(
      { vendorChatId: CHAT_ID },
      { text: 'Morning or evening?' },
    );
  });
});
