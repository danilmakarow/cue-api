import { CapturedSend } from './e2e/capturing-vendor.connector';
import { E2eHarness, SeededFixtures } from './e2e/harness';
import { completion, toolCall } from './e2e/scripted-ai.connector';
import { AiModelRole, AiStopReason } from '@/modules/ai/ai.types';
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

  /** Reads the text off a captured `sendMessage`. */
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

    expect(reply.method).toBe('sendMessage');
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

    expect(reply.method).toBe('sendMessage');
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

  it('holds an overlapping create and asks via inline keyboard (no commit yet)', async () => {
    // Seed an existing timed task that the new create will overlap.
    const taskService = harness.moduleRef.get(TaskService);

    await taskService.create(fixtures.user.id, {
      calendarId: fixtures.calendar.id,
      title: 'Existing meeting',
      startAt: '2026-07-01T15:00:00.000Z',
      endAt: '2026-07-01T16:00:00.000Z',
      timezone: 'UTC',
    });

    const tasksBefore = await harness.countTasks(fixtures.calendar.id);

    expect(tasksBefore).toBe(1);

    // The model creates an overlapping timed task; the dispatcher holds it.
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
    ]);

    await harness.postWebhook(
      harness.buildTextUpdate(fixtures.chatId, 'book dentist at 3:30'),
    );

    const ask = await harness.vendor.nextSend();

    // The hold is asked via an inline keyboard (sendActions), not a plain reply.
    expect(ask.method).toBe('sendActions');

    const actions = ask.payload as {
      text: string;
      buttons: Array<Array<{ label: string; callbackData: string }>>;
    };

    expect(actions.buttons[0][0].label).toMatch(/book anyway/i);
    expect(actions.buttons[0][1].label).toMatch(/cancel/i);

    // A held key was written to Redis with a TTL set.
    const heldKeys = await harness.heldConflictKeys();

    expect(heldKeys).toHaveLength(1);

    const ttl = await harness.redis.ttl(heldKeys[0]);

    expect(ttl).toBeGreaterThan(0);

    // No NEW task committed — still just the seeded overlapping one.
    const tasksAfter = await harness.countTasks(fixtures.calendar.id);

    expect(tasksAfter).toBe(1);

    // Confirming via the callback then commits the held write and burns the key.
    const confirmData = actions.buttons[0][0].callbackData;

    harness.scriptedAi.script([]);
    await harness.postWebhook(
      harness.buildCallbackUpdate(fixtures.chatId, confirmData),
    );

    // The callback path acknowledges, then sends a confirmation reply.
    let confirmReply = await harness.vendor.nextSend();

    if (confirmReply.method === 'acknowledgeCallback') {
      confirmReply = await harness.vendor.nextSend();
    }

    expect(replyTextOf(confirmReply)).toMatch(/booked|done/i);

    const tasksFinal = await harness.countTasks(fixtures.calendar.id);

    expect(tasksFinal).toBe(2);

    const heldKeysAfter = await harness.heldConflictKeys();

    expect(heldKeysAfter).toHaveLength(0);
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

    // The question is asked via an inline keyboard, not a plain reply.
    expect(ask.method).toBe('sendActions');

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

    // The callback path acknowledges, then sends the continued reply.
    let resumeReply = await harness.vendor.nextSend();

    if (resumeReply.method === 'acknowledgeCallback') {
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

    expect(reply.method).toBe('sendMessage');
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
