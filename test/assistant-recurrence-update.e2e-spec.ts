import {
  CapturedSend,
  CapturingVendorConnector,
} from './e2e/capturing-vendor.connector';
import { E2eHarness, SeededFixtures } from './e2e/harness';
import { completion, toolCall } from './e2e/scripted-ai.connector';
import { AiStopReason } from '@/modules/ai/ai.types';
import {
  RecurrenceEndType,
  RecurrenceFrequency,
} from '@/modules/database/entities';

/**
 * Real-request E2E proving the AI update tools can CHANGE and CLEAR an inline
 * recurrence rule through the FULL stack (scripted model emits the tool call →
 * real ToolDispatcher → TaskService / TaskGroupService → Postgres), then asserts
 * the persisted `recurrenceConfig` JSONB column directly. This is the decisive
 * regression for the reported bug: before the fix the nullable-recurrence schema
 * widening (ADR 0054 / `nullableRecurrenceJsonSchema`, `type: ['object','null']`)
 * was missing, so `recurrence: null` was unreachable and an interval edit could
 * not stop / re-grammar a series.
 *
 * Boots the WHOLE app against the dedicated docker Postgres + Redis with the real
 * in-process BullMQ worker, the captured Telegram vendor (real ingress), and the
 * deterministic scripted AI — the same harness the core pipeline e2e uses. The
 * harness drives PRIVATE chats by default, so under ADR 0059 each model turn's
 * finalised answer is a FRESH real `sendMessage` (awaited via
 * `nextReply(CapturingVendorConnector.isPrivateAnswer)`), not an `editMessageText`
 * morph. No real LLM is spent — every path is driven through the scripted connector.
 *
 * A recurring task surfaced by `list_tasks` carries an `originalStart`, so its
 * handle resolves to a recurring instance and `update_task` requires an
 * `editScope`. The natural model behaviour for "change how it repeats" is
 * `editScope: 'all'`, which threads the recurrence tri-state (a DTO replaces, null
 * clears, omitted leaves) into the master `TaskService.update`.
 */
describe('Assistant recurrence update (real-request e2e): change + clear via update_task / update_group', () => {
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
   * Reads the text off a captured reply. The terminal reply payload carries a
   * `.text` on every path — a private finalised-answer `sendMessage`, a private
   * `ask_user` `sendActions`, or a non-private morph `editMessageText` — so
   * `/.../i` patterns match across all of them.
   */
  const replyTextOf = (send: CapturedSend): string =>
    (send.payload as { text: string }).text;

  /**
   * Awaits the PRIVATE-path finalised answer (ADR 0059): the fresh real
   * `sendMessage` (`format === Html`) that supersedes the self-expiring draft. The
   * morph-only `nextSend()` records this as framing and never resolves on it, so
   * the answer is awaited via the predicate seam. Bounded by jest's testTimeout.
   */
  const nextAnswer = (): Promise<CapturedSend> =>
    harness.vendor.nextReply(CapturingVendorConnector.isPrivateAnswer);

  /**
   * Reads the inline `recurrenceConfig` JSONB column off the task groups in a
   * calendar, ordered by creation. The harness exposes only a per-TASK settings
   * reader, so this queries the `task_group` table directly via the public
   * DataSource (tests read straight, bypassing the 3-layer data-access constraints
   * that bind feature code) to assert the group recurrence CHANGE / CLEAR landed.
   */
  const listGroupRecurrence = (
    calendarId: string,
  ): Promise<
    Array<{ name: string; recurrenceConfig: Record<string, unknown> | null }>
  > =>
    harness.dataSource.query(
      `SELECT name, "recurrenceConfig" FROM task_group WHERE "calendarId" = $1 ORDER BY "createdAt" ASC`,
      [calendarId],
    );

  it('update_task CHANGES a WEEKLY recurrence interval 1 → 2 (persisted recurrenceConfig.interval = 2)', async () => {
    // Round 1: create a WEEKLY-interval-1 recurring task. Round 2: list it so the
    // model gets a handle (e1). Round 3: update_task with editScope 'all' replacing
    // the rule with WEEKLY-interval-2. Round 4: confirm.
    harness.scriptedAi.script([
      completion({
        stopReason: AiStopReason.TOOL_USE,
        toolCalls: [
          toolCall('create_task', {
            title: 'Weekly review',
            startAt: '2026-07-06T09:00:00.000Z',
            endAt: '2026-07-06T09:30:00.000Z',
            timezone: 'UTC',
            recurrence: {
              frequency: RecurrenceFrequency.WEEKLY,
              interval: 1,
              endType: RecurrenceEndType.NEVER,
            },
          }),
        ],
      }),
      completion({
        stopReason: AiStopReason.TOOL_USE,
        toolCalls: [
          toolCall('list_tasks', {
            from: '2026-07-06T00:00:00.000Z',
            to: '2026-07-07T00:00:00.000Z',
          }),
        ],
      }),
      completion({
        stopReason: AiStopReason.TOOL_USE,
        toolCalls: [
          toolCall('update_task', {
            handle: 'e1',
            editScope: 'all',
            recurrence: {
              frequency: RecurrenceFrequency.WEEKLY,
              interval: 2,
              endType: RecurrenceEndType.NEVER,
            },
          }),
        ],
      }),
      completion({
        stopReason: AiStopReason.END_TURN,
        text: 'Done — your review now repeats every other week.',
      }),
    ]);

    await harness.postWebhook(
      harness.buildTextUpdate(
        fixtures.chatId,
        'make my weekly review repeat every other week instead',
      ),
    );

    const reply = await nextAnswer();

    expect(reply.method).toBe('sendMessage');
    expect(replyTextOf(reply)).toMatch(/every other week|review/i);

    // The single task's inline recurrenceConfig now carries interval 2 — the rule
    // was re-grammared in place (ADR 0054), still no recurrence_rule row anywhere.
    const rows = await harness.listTaskSettings(fixtures.calendar.id);

    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('Weekly review');
    expect(rows[0].recurrenceConfig).not.toBeNull();
    expect(rows[0].recurrenceConfig).toMatchObject({
      frequency: RecurrenceFrequency.WEEKLY,
      interval: 2,
      endType: RecurrenceEndType.NEVER,
    });

    expect(await harness.tableExists('recurrence_rule')).toBe(false);

    // The effective-settings resolver surfaces the changed interval as the task's
    // effective recurrence (task-wins, ADR 0054).
    const effective = await harness.resolveEffectiveForFirstTask(
      fixtures.calendar.id,
    );

    expect(effective.recurrence).toMatchObject({
      frequency: RecurrenceFrequency.WEEKLY,
      interval: 2,
    });
  });

  it('update_task CLEARS the recurrence (recurrence: null) so the task stops repeating (recurrenceConfig = null)', async () => {
    // Round 1: create a WEEKLY recurring task. Round 2: list it for a handle.
    // Round 3: update_task with editScope 'all' and recurrence: null — the
    // stop-repeating clear path that the nullable-recurrence widening unlocks.
    // Round 4: confirm.
    harness.scriptedAi.script([
      completion({
        stopReason: AiStopReason.TOOL_USE,
        toolCalls: [
          toolCall('create_task', {
            title: 'Standup',
            startAt: '2026-07-06T09:00:00.000Z',
            endAt: '2026-07-06T09:15:00.000Z',
            timezone: 'UTC',
            recurrence: {
              frequency: RecurrenceFrequency.WEEKLY,
              interval: 1,
              byWeekday: [0],
              endType: RecurrenceEndType.NEVER,
            },
          }),
        ],
      }),
      completion({
        stopReason: AiStopReason.TOOL_USE,
        toolCalls: [
          toolCall('list_tasks', {
            from: '2026-07-06T00:00:00.000Z',
            to: '2026-07-07T00:00:00.000Z',
          }),
        ],
      }),
      completion({
        stopReason: AiStopReason.TOOL_USE,
        toolCalls: [
          toolCall('update_task', {
            handle: 'e1',
            editScope: 'all',
            recurrence: null,
          }),
        ],
      }),
      completion({
        stopReason: AiStopReason.END_TURN,
        text: 'Done — your standup no longer repeats.',
      }),
    ]);

    await harness.postWebhook(
      harness.buildTextUpdate(
        fixtures.chatId,
        'stop my standup from repeating, make it a one-off',
      ),
    );

    const reply = await nextAnswer();

    expect(reply.method).toBe('sendMessage');
    expect(replyTextOf(reply)).toMatch(/no longer repeats|standup/i);

    // The recurrence was cleared to null in place: one row, recurrenceConfig now
    // null — the series stopped repeating (ADR 0054). This is the path that was
    // unreachable before the nullable-recurrence schema widening.
    const rows = await harness.listTaskSettings(fixtures.calendar.id);

    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('Standup');
    expect(rows[0].recurrenceConfig).toBeNull();

    // The effective resolver now surfaces no recurrence (the inline config is gone).
    const effective = await harness.resolveEffectiveForFirstTask(
      fixtures.calendar.id,
    );

    expect(effective.recurrence).toBeNull();
  });

  it('update_group CHANGES then CLEARS the group default recurrence (recurrenceConfig.interval = 2, then null)', async () => {
    // Round 1: create a group carrying a MONTHLY-interval-1 default recurrence.
    // Round 2: update_group changing the default to MONTHLY-interval-2. Round 3:
    // update_group clearing the default recurrence (recurrence: null). Round 4:
    // confirm. update_group resolves the group BY NAME, so no handle/list is needed.
    harness.scriptedAi.script([
      completion({
        stopReason: AiStopReason.TOOL_USE,
        toolCalls: [
          toolCall('create_group', {
            name: 'Bills',
            recurrence: {
              frequency: RecurrenceFrequency.MONTHLY,
              interval: 1,
              byMonthDay: [1],
              endType: RecurrenceEndType.NEVER,
            },
          }),
        ],
      }),
      completion({
        stopReason: AiStopReason.TOOL_USE,
        toolCalls: [
          toolCall('update_group', {
            group: 'Bills',
            recurrence: {
              frequency: RecurrenceFrequency.MONTHLY,
              interval: 2,
              byMonthDay: [1],
              endType: RecurrenceEndType.NEVER,
            },
          }),
        ],
      }),
      completion({
        stopReason: AiStopReason.TOOL_USE,
        toolCalls: [
          toolCall('update_group', {
            group: 'Bills',
            recurrence: null,
          }),
        ],
      }),
      completion({
        stopReason: AiStopReason.END_TURN,
        text: 'Done — your Bills group no longer carries a default recurrence.',
      }),
    ]);

    await harness.postWebhook(
      harness.buildTextUpdate(
        fixtures.chatId,
        'change my Bills group to repeat every other month, then drop the default repeat entirely',
      ),
    );

    const reply = await nextAnswer();

    expect(reply.method).toBe('sendMessage');
    expect(replyTextOf(reply)).toMatch(/bills|recurrence|repeat/i);

    // After the CHANGE-then-CLEAR pair, the group's inline default recurrenceConfig
    // landed on its terminal state: cleared to null. The interval-2 CHANGE is proven
    // by the same tri-state path persisting on the row before the null clear (both
    // ran in-loop through the real TaskGroupService.update against Postgres).
    const groups = await listGroupRecurrence(fixtures.calendar.id);

    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe('Bills');
    expect(groups[0].recurrenceConfig).toBeNull();
  });

  it('update_group CHANGES the group default recurrence interval 1 → 2 (persisted recurrenceConfig.interval = 2)', async () => {
    // Isolates the group recurrence CHANGE on its own row state (no subsequent
    // clear): create a MONTHLY-interval-1 group default, then update_group to
    // MONTHLY-interval-2, and assert the persisted interval is 2.
    harness.scriptedAi.script([
      completion({
        stopReason: AiStopReason.TOOL_USE,
        toolCalls: [
          toolCall('create_group', {
            name: 'Chores',
            recurrence: {
              frequency: RecurrenceFrequency.MONTHLY,
              interval: 1,
              byMonthDay: [1],
              endType: RecurrenceEndType.NEVER,
            },
          }),
        ],
      }),
      completion({
        stopReason: AiStopReason.TOOL_USE,
        toolCalls: [
          toolCall('update_group', {
            group: 'Chores',
            recurrence: {
              frequency: RecurrenceFrequency.MONTHLY,
              interval: 2,
              byMonthDay: [1],
              endType: RecurrenceEndType.NEVER,
            },
          }),
        ],
      }),
      completion({
        stopReason: AiStopReason.END_TURN,
        text: 'Done — your Chores group now defaults to every other month.',
      }),
    ]);

    await harness.postWebhook(
      harness.buildTextUpdate(
        fixtures.chatId,
        'make my Chores group default to every other month',
      ),
    );

    const reply = await nextAnswer();

    expect(reply.method).toBe('sendMessage');
    expect(replyTextOf(reply)).toMatch(/chores|every other month|repeat/i);

    const groups = await listGroupRecurrence(fixtures.calendar.id);

    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe('Chores');
    expect(groups[0].recurrenceConfig).not.toBeNull();
    expect(groups[0].recurrenceConfig).toMatchObject({
      frequency: RecurrenceFrequency.MONTHLY,
      interval: 2,
      byMonthDay: [1],
    });
  });
});
