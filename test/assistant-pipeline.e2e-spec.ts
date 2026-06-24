import { CapturedSend } from './e2e/capturing-vendor.connector';
import { E2eHarness, SeededFixtures } from './e2e/harness';
import { completion, toolCall } from './e2e/scripted-ai.connector';
import { AiModelRole, AiStopReason } from '@/modules/ai/ai.types';
import { ConflictPolicy } from '@/modules/database/entities';
import { TaskService } from '@/modules/task/task.service';

/**
 * Real-request E2E for the assistant pipeline. Boots the WHOLE app (AppModule)
 * against the local docker-compose Postgres + Redis, runs the BullMQ worker
 * in-process, and exercises the prod path: a real HTTP webhook POST →
 * controller enqueue → in-process consumer → orchestrator → tool dispatch →
 * captured vendor reply, with the DB asserted on for the actual writes. Only the
 * two leaf connectors are faked: the vendor (captured, real ingress) and the AI
 * (deterministic scripted completions). The turn is awaited on the vendor-send
 * seam — the deterministic terminal signal of a finished turn.
 */
describe('Assistant pipeline (real-request e2e, deterministic AI)', () => {
  let harness: E2eHarness;
  let fixtures: SeededFixtures;

  beforeAll(async () => {
    harness = await E2eHarness.boot();
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    fixtures = await harness.seedLinkedUser();
  });

  afterEach(async () => {
    await harness.settleBackground();
    await harness.reset();
  });

  /**
   * Reads the text off a captured reply. Under ADR 0053 the substantive reply is
   * an `editMessageText` (the morph) whose payload still carries a `.text`; the
   * text is HTML-converted but plain words survive, so `/.../i` patterns match.
   */
  const replyTextOf = (send: CapturedSend): string =>
    (send.payload as { text: string }).text;

  it('creates a task from a webhook and confirms it (simple create_task)', async () => {
    // Round 1: the model calls create_task. Round 2: it confirms in plain text.
    harness.scriptedAi.script([
      completion({
        stopReason: AiStopReason.TOOL_USE,
        toolCalls: [toolCall('create_task', { title: 'buy milk' })],
      }),
      completion({
        stopReason: AiStopReason.END_TURN,
        text: 'Done — added "buy milk" to your list.',
      }),
    ]);

    await harness.postWebhook(
      harness.buildTextUpdate(fixtures.chatId, 'add buy milk'),
    );

    const reply = await harness.vendor.nextSend();

    expect(reply.method).toBe('editMessageText');
    expect(reply.target).toEqual({ vendorChatId: fixtures.chatId });
    expect(replyTextOf(reply)).toMatch(/buy milk/i);

    // The write actually committed: exactly one Task in the user's primary calendar.
    const tasks = await harness.listTasks(fixtures.calendar.id);

    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe('buy milk');
  });

  it('creates N tasks from a single create_tasks batch (committedCount path)', async () => {
    harness.scriptedAi.script([
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
      completion({
        stopReason: AiStopReason.END_TURN,
        text: 'Created all three lessons.',
      }),
    ]);

    await harness.postWebhook(
      harness.buildTextUpdate(fixtures.chatId, 'create three lessons'),
    );

    const reply = await harness.vendor.nextSend();

    expect(reply.method).toBe('editMessageText');
    expect(replyTextOf(reply)).toMatch(/three|3/i);

    const tasks = await harness.listTasks(fixtures.calendar.id);

    expect(tasks).toHaveLength(3);
    expect(tasks.map((task) => task.title).sort()).toEqual([
      'Lesson 1',
      'Lesson 2',
      'Lesson 3',
    ]);
  });

  it('re-drives a narration-without-write turn and commits on the forced round (ADR 0009)', async () => {
    // Round 1: pure narration, ZERO tool calls (a structural narration-without
    // -write). The orchestrator appends the corrective nudge and re-drives with
    // tool_choice:'any'. Round 2: under the forced choice the model calls
    // create_task. Round 3: the genuine success reply.
    harness.scriptedAi.script([
      completion({
        stopReason: AiStopReason.END_TURN,
        text: 'Adding it now.',
      }),
      completion({
        stopReason: AiStopReason.TOOL_USE,
        toolCalls: [toolCall('create_task', { title: 'dentist' })],
      }),
      completion({
        stopReason: AiStopReason.END_TURN,
        text: 'Done — created your dentist appointment.',
      }),
    ]);

    await harness.postWebhook(
      harness.buildTextUpdate(fixtures.chatId, 'add a dentist appointment'),
    );

    const reply = await harness.vendor.nextSend();

    // The final reply is the REAL confirmation, not the false-success mask.
    expect(replyTextOf(reply)).toMatch(/dentist/i);
    expect(replyTextOf(reply)).not.toMatch(/don't think that actually saved/i);

    // committedWrites > 0: the write landed in the DB.
    const tasks = await harness.listTasks(fixtures.calendar.id);

    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe('dentist');

    // The re-drive request carried tool_choice:'any' on the SECOND round only.
    const choices = harness.scriptedAi.capturedRequests.map(
      (request) => request.toolChoice,
    );

    expect(choices[0]).toBeUndefined();
    expect(choices[1]).toBe('any');

    // The audit trail records the narration round with its correctionReason.
    const auditRows = await harness.listToolAuditRows();
    const narrationRow = auditRows.find(
      (row) => row.toolPayload?.correctionReason !== undefined,
    );

    expect(narrationRow).toBeDefined();
    expect(narrationRow?.toolPayload?.correctionReason).toBe(
      'claim_without_writes',
    );
  });

  it('CASE 1 (core no-double-book): an unauthorized overlapping create is REFUSED in-loop, NO write, model steered to ask_user (ADR 0011 + 0044)', async () => {
    // Seed an existing timed task the new create will overlap.
    const taskService = harness.moduleRef.get(TaskService);

    await taskService.create(fixtures.user.id, {
      calendarId: fixtures.calendar.id,
      title: 'Existing meeting',
      startAt: '2026-07-01T15:00:00.000Z',
      endAt: '2026-07-01T16:00:00.000Z',
      timezone: 'UTC',
    });

    expect(await harness.countTasks(fixtures.calendar.id)).toBe(1);

    // Round 1: the model issues an overlapping create with NO authorization. The
    // dispatcher REFUSES it with a recoverable is_error restating the clash + the
    // default-deny rule (no hold, no sendActions). Round 2: heeding that, the model
    // calls ask_user — the turn suspends, still NO new write.
    harness.scriptedAi.script([
      completion({
        stopReason: AiStopReason.TOOL_USE,
        toolCalls: [
          toolCall('create_task', {
            title: 'Dentist',
            startAt: '2026-07-01T15:30:00.000Z',
            endAt: '2026-07-01T16:30:00.000Z',
          }),
        ],
      }),
      completion({
        stopReason: AiStopReason.TOOL_USE,
        toolCalls: [
          toolCall('ask_user', {
            question: 'That clashes with "Existing meeting". Book over it?',
            options: [
              { id: 'yes', label: 'Book anyway' },
              { id: 'no', label: 'Pick another time' },
            ],
          }),
        ],
      }),
    ]);

    await harness.postWebhook(
      harness.buildTextUpdate(fixtures.chatId, 'book dentist at 3:30'),
    );

    const ask = await harness.vendor.nextSend();

    // The clash surfaced as an ask_user inline-keyboard question (the model's
    // choice), NOT a deterministic hold keyboard — there is no held Redis key.
    // Under ADR 0053 the question MORPHS the loading line via editMessageText
    // carrying the inline keyboard, instead of a fresh sendActions.
    expect(ask.method).toBe('editMessageText');

    const actions = ask.payload as {
      text: string;
      buttons: Array<Array<{ label: string; callbackData: string }>>;
    };

    expect(actions.text).toMatch(/clash|over it/i);

    // The dispatcher fed back a recoverable conflict tool_result (default-deny),
    // proving the refusal happened in-loop rather than via a hold channel.
    const auditRows = await harness.listToolAuditRows();
    const refusalRow = auditRows.find((row) =>
      JSON.stringify(row.toolPayload ?? {}).match(/Do NOT book over it/i),
    );

    expect(refusalRow).toBeDefined();

    // A durable pending_question exists (the ask_user suspend) — NOT a held key.
    expect(await harness.listPendingQuestions()).toHaveLength(1);

    // CORE INVARIANT: no new task committed — still just the seeded overlapping one.
    expect(await harness.countTasks(fixtures.calendar.id)).toBe(1);
  });

  it('CASE 2 (explicit in-message authorization): confirmOverlap lands the overlapping write (ADR 0011 + 0044)', async () => {
    const taskService = harness.moduleRef.get(TaskService);

    await taskService.create(fixtures.user.id, {
      calendarId: fixtures.calendar.id,
      title: 'Existing meeting',
      startAt: '2026-07-01T15:00:00.000Z',
      endAt: '2026-07-01T16:00:00.000Z',
      timezone: 'UTC',
    });

    // The user authorized it in their message, so the model sets confirmOverlap:
    // the gate is skipped and the overlapping write COMMITS in one turn.
    harness.scriptedAi.script([
      completion({
        stopReason: AiStopReason.TOOL_USE,
        toolCalls: [
          toolCall('create_task', {
            title: 'Dentist',
            startAt: '2026-07-01T15:30:00.000Z',
            endAt: '2026-07-01T16:30:00.000Z',
            confirmOverlap: true,
          }),
        ],
      }),
      completion({
        stopReason: AiStopReason.END_TURN,
        text: 'Done — booked the dentist over your meeting as you asked.',
      }),
    ]);

    await harness.postWebhook(
      harness.buildTextUpdate(
        fixtures.chatId,
        'book dentist at 3:30, double-book it over my meeting',
      ),
    );

    const reply = await harness.vendor.nextSend();

    expect(reply.method).toBe('editMessageText');
    expect(replyTextOf(reply)).toMatch(/booked|done/i);

    // The authorized overlap landed: now two tasks, no pending question, no hold.
    expect(await harness.countTasks(fixtures.calendar.id)).toBe(2);
    expect(await harness.listPendingQuestions()).toHaveLength(0);
  });

  it('CASE 4 (destructive replace always asks): a delete without confirmDelete is REFUSED and asks first, NO delete (ADR 0011 + 0044)', async () => {
    const taskService = harness.moduleRef.get(TaskService);

    await taskService.create(fixtures.user.id, {
      calendarId: fixtures.calendar.id,
      title: 'Important meeting',
      startAt: '2026-07-01T15:00:00.000Z',
      endAt: '2026-07-01T16:00:00.000Z',
      timezone: 'UTC',
    });

    expect(await harness.countTasks(fixtures.calendar.id)).toBe(1);

    // Round 1: the model lists the day (so the task gets a handle). Round 2: it
    // tries to delete WITHOUT confirmDelete — the dispatcher refuses destructively
    // and tells it to ask first. Round 3: the model asks the user; the turn
    // suspends with the task still intact.
    harness.scriptedAi.script([
      completion({
        stopReason: AiStopReason.TOOL_USE,
        toolCalls: [
          toolCall('list_tasks', {
            from: '2026-07-01T00:00:00.000Z',
            to: '2026-07-02T00:00:00.000Z',
          }),
        ],
      }),
      completion({
        stopReason: AiStopReason.TOOL_USE,
        toolCalls: [toolCall('delete_task', { handle: 'e1' })],
      }),
      completion({
        stopReason: AiStopReason.TOOL_USE,
        toolCalls: [
          toolCall('ask_user', {
            question: 'Delete "Important meeting"? This cannot be undone.',
            options: [
              { id: 'yes', label: 'Delete it' },
              { id: 'no', label: 'Keep it' },
            ],
          }),
        ],
      }),
    ]);

    await harness.postWebhook(
      harness.buildTextUpdate(fixtures.chatId, 'delete my 3pm'),
    );

    const ask = await harness.vendor.nextSend();

    // ADR 0053: the ask_user question morphs the loading line via editMessageText
    // carrying the inline keyboard (not a fresh sendActions).
    expect(ask.method).toBe('editMessageText');

    // The destructive-replace refusal was fed back to the model in-loop.
    const auditRows = await harness.listToolAuditRows();
    const askFirstRow = auditRows.find((row) =>
      JSON.stringify(row.toolPayload ?? {}).match(/confirmDelete/i),
    );

    expect(askFirstRow).toBeDefined();

    // The task was NOT deleted — destructive replace always asks first.
    expect(await harness.countTasks(fixtures.calendar.id)).toBe(1);
    expect(await harness.listPendingQuestions()).toHaveLength(1);
  });

  it('CASE 5 (standing allow policy): an explicit conflict_policy=allow fact lets an overlap commit WITHOUT asking (ADR 0011 + 0044)', async () => {
    const taskService = harness.moduleRef.get(TaskService);

    await taskService.create(fixtures.user.id, {
      calendarId: fixtures.calendar.id,
      title: 'Existing meeting',
      startAt: '2026-07-01T15:00:00.000Z',
      endAt: '2026-07-01T16:00:00.000Z',
      timezone: 'UTC',
    });

    // The user has a STANDING explicit allow-policy (set once in settings). The
    // context builder surfaces it; the dispatcher proceeds over the overlap with
    // NO confirmOverlap and NO ask.
    await harness.setConflictPolicy(fixtures.user.id, ConflictPolicy.ALLOW);

    harness.scriptedAi.script([
      completion({
        stopReason: AiStopReason.TOOL_USE,
        toolCalls: [
          // No confirmOverlap — the standing allow-policy authorizes it.
          toolCall('create_task', {
            title: 'Dentist',
            startAt: '2026-07-01T15:30:00.000Z',
            endAt: '2026-07-01T16:30:00.000Z',
          }),
        ],
      }),
      completion({
        stopReason: AiStopReason.END_TURN,
        text: 'Done — booked the dentist (overlaps are fine for you).',
      }),
    ]);

    await harness.postWebhook(
      harness.buildTextUpdate(fixtures.chatId, 'book dentist at 3:30'),
    );

    const reply = await harness.vendor.nextSend();

    // It committed without asking: a morphed reply, two tasks, no pending question.
    expect(reply.method).toBe('editMessageText');
    expect(replyTextOf(reply)).toMatch(/booked|done/i);
    expect(await harness.countTasks(fixtures.calendar.id)).toBe(2);
    expect(await harness.listPendingQuestions()).toHaveLength(0);
  });

  it('CASE 5 (standing deny policy): an explicit conflict_policy=deny fact REFUSES an overlap, NO write (ADR 0011 + 0044)', async () => {
    const taskService = harness.moduleRef.get(TaskService);

    await taskService.create(fixtures.user.id, {
      calendarId: fixtures.calendar.id,
      title: 'Existing meeting',
      startAt: '2026-07-01T15:00:00.000Z',
      endAt: '2026-07-01T16:00:00.000Z',
      timezone: 'UTC',
    });

    await harness.setConflictPolicy(fixtures.user.id, ConflictPolicy.DENY);

    // Even if the model sets confirmOverlap, the standing deny-policy overrides it:
    // the dispatcher refuses, the model relays it, NO new write.
    harness.scriptedAi.script([
      completion({
        stopReason: AiStopReason.TOOL_USE,
        toolCalls: [
          toolCall('create_task', {
            title: 'Dentist',
            startAt: '2026-07-01T15:30:00.000Z',
            endAt: '2026-07-01T16:30:00.000Z',
            confirmOverlap: true,
          }),
        ],
      }),
      completion({
        stopReason: AiStopReason.END_TURN,
        text: 'That clashes with your meeting and you never double-book — shall I find another time?',
      }),
    ]);

    await harness.postWebhook(
      harness.buildTextUpdate(fixtures.chatId, 'book dentist at 3:30'),
    );

    const reply = await harness.vendor.nextSend();

    expect(reply.method).toBe('editMessageText');

    // The deny-policy refusal reached the model in-loop.
    const auditRows = await harness.listToolAuditRows();
    const denyRow = auditRows.find((row) =>
      JSON.stringify(row.toolPayload ?? {}).match(/standing policy refuses/i),
    );

    expect(denyRow).toBeDefined();

    // Refused under deny: still just the seeded task, no double-book.
    expect(await harness.countTasks(fixtures.calendar.id)).toBe(1);
  });

  it('suspends on ask_user then resumes on the button tap and commits (ADR 0010 round-trip)', async () => {
    // Round 1: the model asks a clarifying question with two tappable options.
    // The turn must SUSPEND — a pending_question row is written, the inline
    // keyboard is sent, and NO task is committed yet.
    harness.scriptedAi.script([
      completion({
        stopReason: AiStopReason.TOOL_USE,
        toolCalls: [
          toolCall('ask_user', {
            question: 'Which day should I book it?',
            options: [
              { id: 'fri', label: 'Friday' },
              { id: 'sat', label: 'Saturday' },
            ],
          }),
        ],
      }),
    ]);

    await harness.postWebhook(
      harness.buildTextUpdate(fixtures.chatId, 'book me a slot sometime'),
    );

    const ask = await harness.vendor.nextSend();

    // ADR 0053: the question morphs the loading line via editMessageText carrying
    // the inline keyboard, not a fresh sendActions / plain reply.
    expect(ask.method).toBe('editMessageText');

    const actions = ask.payload as {
      text: string;
      buttons: Array<Array<{ label: string; callbackData: string }>>;
    };

    expect(actions.text).toBe('Which day should I book it?');
    expect(actions.buttons[0][0].label).toBe('Friday');

    // A durable pending question was written (status AWAITING) and the hot Redis
    // index mirrored.
    const pending = await harness.listPendingQuestions();

    expect(pending).toHaveLength(1);
    expect(pending[0].status).toBe('AWAITING');

    const hotKeys = await harness.pendingQuestionKeys();

    expect(hotKeys).toHaveLength(1);

    // The callback data carries the durable row id + the chosen option id.
    const fridayCallback = actions.buttons[0][0].callbackData;

    expect(fridayCallback).toBe(`ask:${pending[0].id}:fri`);

    // No task committed while suspended.
    expect(await harness.countTasks(fixtures.calendar.id)).toBe(0);

    // Resume: the user taps "Friday". The model is re-invoked with the synthetic
    // answer fed back; round 2 it creates the task, round 3 it confirms.
    harness.scriptedAi.script([
      completion({
        stopReason: AiStopReason.TOOL_USE,
        toolCalls: [
          toolCall('create_task', {
            title: 'Booked slot',
            startAt: '2026-07-03T15:00:00.000Z',
            endAt: '2026-07-03T16:00:00.000Z',
          }),
        ],
      }),
      completion({
        stopReason: AiStopReason.END_TURN,
        text: 'Done — booked your slot for Friday.',
      }),
    ]);

    await harness.postWebhook(
      harness.buildCallbackUpdate(fixtures.chatId, fridayCallback),
    );

    // The callback path acknowledges, morphs the original question (R3 / ADR 0058
    // — strips the buttons + appends "User selected: Friday"), then sends the
    // continued reply. Drain to the resume's TERMINAL ANSWER morph specifically:
    // skip the ack, the answered-question morph (clearButtons — its text ALSO
    // contains "Friday"), and any `<pre>` recap/loading frame, so we only assert on
    // the real confirmation AND so the resumed model rounds have been captured
    // before the request assertions below (otherwise we race the in-flight turn).
    let resumeReply = await harness.vendor.nextSend();

    while (
      resumeReply.method !== 'editMessageText' ||
      (resumeReply.payload as { clearButtons?: boolean }).clearButtons ===
        true ||
      !/booked your slot/i.test(replyTextOf(resumeReply))
    ) {
      resumeReply = await harness.vendor.nextSend();
    }

    expect(replyTextOf(resumeReply)).toMatch(/friday/i);

    // The model WAS re-invoked on resume: the resume turn's first request carried
    // the suspended round with EXACTLY ONE synthetic ask_user tool_result whose
    // content is the chosen LABEL ("Friday").
    const resumeRequests = harness.scriptedAi.capturedRequests;
    const firstResumeRequest = resumeRequests[0];

    expect(firstResumeRequest.toolRounds).toBeDefined();

    const askRound = firstResumeRequest.toolRounds?.[0];

    expect(askRound?.toolResults).toHaveLength(1);
    expect(askRound?.toolResults[0].content).toBe('Friday');

    // committedWrites: the task landed in the DB.
    const tasks = await harness.listTasks(fixtures.calendar.id);

    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe('Booked slot');

    // The pending question was claimed (ANSWERED) and the hot key cleared.
    const pendingAfter = await harness.listPendingQuestions();

    expect(pendingAfter[0].status).toBe('ANSWERED');
    expect(await harness.pendingQuestionKeys()).toHaveLength(0);
  });

  it('answers a read-only Q&A with no writes and no re-drive', async () => {
    // Round 1: a read (list_tasks). Round 2: a genuine text answer, zero commits.
    harness.scriptedAi.script([
      completion({
        stopReason: AiStopReason.TOOL_USE,
        toolCalls: [
          toolCall('list_tasks', {
            from: '2026-07-01T00:00:00.000Z',
            to: '2026-07-02T00:00:00.000Z',
          }),
        ],
      }),
      completion({
        stopReason: AiStopReason.END_TURN,
        text: 'You have nothing scheduled that day.',
      }),
    ]);

    await harness.postWebhook(
      harness.buildTextUpdate(fixtures.chatId, "what's on tomorrow?"),
    );

    const reply = await harness.vendor.nextSend();

    expect(reply.method).toBe('editMessageText');
    expect(replyTextOf(reply)).toMatch(/nothing scheduled/i);

    // Read-only narration is genuine: the loop must NOT have forced a re-drive,
    // so exactly the two scripted MAIN rounds ran (no third forced round). The
    // BACKGROUND per-round recap (Story 13 / ADR 0041) is additive new traffic and
    // is excluded from the loop-round count by filtering on the MAIN model role.
    const mainRequests = harness.scriptedAi.capturedRequests.filter(
      (request) => request.modelRole === AiModelRole.MAIN,
    );

    expect(mainRequests).toHaveLength(2);
    expect(mainRequests.every((request) => request.toolChoice !== 'any')).toBe(
      true,
    );

    // No tasks were created.
    const tasks = await harness.countTasks(fixtures.calendar.id);

    expect(tasks).toBe(0);
  });
});
