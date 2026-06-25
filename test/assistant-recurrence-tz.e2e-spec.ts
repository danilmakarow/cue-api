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
 * THE DECISIVE timezone E2E — reproduces the EXACT reported bug and proves the
 * wall-clock write-boundary fix end to end. The process runs with `TZ=UTC`
 * (matching the prod server) and the user's persisted timezone is `Europe/Moscow`
 * (UTC+3). A naive wall-clock ISO (no offset, EXACTLY as the model emits it) must
 * be interpreted in the USER's zone, so a `14:30` move on a Moscow user persists
 * as `11:30Z` and reads back as `14:30` — NOT `17:30` (+3h), which is what the old
 * `new Date(naive)` (naive-as-UTC) produced.
 *
 * The whole stack is exercised: scripted model → real ToolDispatcher (which
 * forwards the resolved user zone) → real TaskService (`parseWallClockInZone`) →
 * Postgres, then read back two independent ways that bypass the bot's echoed claim:
 *   1. the RENDERED `list_tasks` agenda line the model + user actually see, read
 *      off the persisted `role = 'tool'` conversation_message (the formatter
 *      `setZone(user.timezone)`s the stored instant back to the wall-clock), and
 *   2. the DB master row's stored `startAt`, asserted as an absolute `11:30Z`.
 *
 * Boots the WHOLE app against the dedicated test Postgres + Redis (run with
 * `DB_PORT=5499 REDIS_PORT=6399` so the dedicated containers never collide with
 * the dev infra on 5432/6379), the in-process BullMQ worker, the captured Telegram
 * vendor (real ingress), and the deterministic scripted AI — the same harness the
 * other pipeline e2es use. The harness drives PRIVATE chats, so each finalized
 * answer is a fresh real `sendMessage` (awaited via `nextAnswer`).
 */
describe('Assistant timezone wall-clock (real-request e2e): a Moscow user reads back the wall-clock they sent, not +3h', () => {
  let harness: E2eHarness;
  let fixtures: SeededFixtures;
  let originalTz: string | undefined;

  beforeAll(async () => {
    // Force the process TZ to UTC (prod parity) so the regression is pinned: under
    // the old naive-as-UTC parse, a Moscow `14:30` would have stored + rendered as
    // `14:30Z`/`17:30` local — the forced TZ removes any host-tz coincidence.
    originalTz = process.env.TZ;
    process.env.TZ = 'UTC';
    harness = await E2eHarness.boot();
  });

  afterAll(async () => {
    await harness.close();
    process.env.TZ = originalTz;
  });

  beforeEach(async () => {
    // A UTC+3 user — the crux of the bug.
    fixtures = await harness.seedLinkedUser('555000222', 'Europe/Moscow');
  });

  afterEach(async () => {
    await harness.settleBackground();
    await harness.reset();
  });

  /**
   * Reads the text off a captured reply. The terminal reply payload carries a
   * `.text` on every private path (finalised-answer `sendMessage`, `ask_user`
   * `sendActions`), so `/.../i` patterns match across them.
   */
  const replyTextOf = (send: CapturedSend): string =>
    (send.payload as { text: string }).text;

  /**
   * Awaits the PRIVATE-path finalised answer (ADR 0059): the fresh real
   * `sendMessage` that supersedes the self-expiring draft, via the predicate seam
   * (the morph-only `nextSend()` never resolves on it).
   */
  const nextAnswer = (): Promise<CapturedSend> =>
    harness.vendor.nextReply(CapturingVendorConnector.isPrivateAnswer);

  /**
   * Returns the most recent rendered `list_tasks` agenda block — the EXACT schedule
   * text the model + user see, read off the `resultContent` of the `list_tasks`
   * step inside a persisted `role = 'tool'` round's `toolPayload` (the audit `.text`
   * is only a per-round summary; the rendered lines live in the step record). The
   * formatter `setZone(user.timezone)`s the stored instant, so this is where a +3h
   * drift would surface as `17:30` instead of `14:30`. Picks the LAST `list_tasks`
   * result so a scenario that lists twice reads the POST-move render.
   */
  const lastRenderedAgenda = async (): Promise<string> => {
    const rows = await harness.listToolAuditRows();
    const listResults: string[] = [];

    for (const row of rows) {
      const steps = (row.toolPayload?.steps ?? []) as Array<{
        name: string;
        resultContent: string;
      }>;

      for (const step of steps) {
        if (step.name === 'list_tasks') {
          listResults.push(step.resultContent);
        }
      }
    }

    if (listResults.length === 0) {
      throw new Error(
        `No list_tasks result found in tool audit. Rows: ${JSON.stringify(
          rows.map((row) => row.toolPayload),
        )}`,
      );
    }

    return listResults[listResults.length - 1];
  };

  it('THE BUG: move a WEEKLY series to 14:30 via editScope:all — reads back 14:30 (NOT 17:30), DB master is 11:30Z', async () => {
    // Round 1: create a WEEKLY Thursday series at a Moscow wall-clock 09:00 (so the
    // pre-move anchor is unambiguous). Round 2: list the original day to mint a
    // handle (e1). Round 3: move the WHOLE series to 2026-06-25T14:30–15:00 with a
    // NAIVE ISO and editScope:'all' (EXACTLY as the model sends). Round 4: list the
    // moved day so the rendered line is the post-move agenda. Round 5: confirm.
    harness.scriptedAi.script([
      completion({
        stopReason: AiStopReason.TOOL_USE,
        toolCalls: [
          toolCall('create_task', {
            title: 'Weekly review',
            // Naive Moscow wall-clock (Thu 18 Jun 09:00 MSK = 06:00Z).
            startAt: '2026-06-18T09:00:00',
            endAt: '2026-06-18T09:30:00',
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
            from: '2026-06-18T00:00:00.000Z',
            to: '2026-06-19T00:00:00.000Z',
          }),
        ],
      }),
      completion({
        stopReason: AiStopReason.TOOL_USE,
        toolCalls: [
          toolCall('update_task', {
            handle: 'e1',
            editScope: 'all',
            // The crux: a NAIVE ISO, no offset — must localize in Moscow ⇒ 11:30Z.
            startAt: '2026-06-25T14:30:00',
            endAt: '2026-06-25T15:00:00',
          }),
        ],
      }),
      completion({
        stopReason: AiStopReason.TOOL_USE,
        toolCalls: [
          toolCall('list_tasks', {
            from: '2026-06-25T00:00:00.000Z',
            to: '2026-06-26T00:00:00.000Z',
          }),
        ],
      }),
      completion({
        stopReason: AiStopReason.END_TURN,
        text: 'Done — your weekly review now runs 14:30–15:00.',
      }),
    ]);

    await harness.postWebhook(
      harness.buildTextUpdate(
        fixtures.chatId,
        'move my weekly review to 14:30 every week',
      ),
    );

    const reply = await nextAnswer();

    expect(reply.method).toBe('sendMessage');
    expect(replyTextOf(reply)).toMatch(/weekly review|14:30/i);

    // PROOF 1 — the RENDERED agenda line the user/model see shows 14:30–15:00 in
    // the Moscow zone, NOT 17:30 (the +3h bug). This is read off the persisted tool
    // output (the formatter's setZone render), not the bot's echoed sentence.
    const agenda = await lastRenderedAgenda();

    expect(agenda).toContain('14:30');
    expect(agenda).toContain('14:30–15:00');
    expect(agenda).not.toContain('17:30');
    // And it still reads as the recurring series (the recurrence-context marker).
    expect(agenda).toContain('🔁');

    // PROOF 2 — the DB master row stores the ABSOLUTE instant 11:30Z (14:30 MSK),
    // not 14:30Z. tz-independent assertion (UTC ISO), so the forced TZ can't mask it.
    const instants = await harness.listTaskInstants(fixtures.calendar.id);

    expect(instants).toHaveLength(1);
    expect(instants[0].title).toBe('Weekly review');
    expect(instants[0].startAt).toBe('2026-06-25T11:30:00.000Z');
    expect(instants[0].endAt).toBe('2026-06-25T12:00:00.000Z');
  });

  it('CREATE with naive 09:00 for a Moscow user reads back 09:00 (NOT 12:00), DB is 06:00Z', async () => {
    // Round 1: create a one-off at a naive 09:00. Round 2: list the day. Round 3:
    // confirm. The naive 09:00 must localize to Moscow ⇒ 06:00Z and render as 09:00.
    harness.scriptedAi.script([
      completion({
        stopReason: AiStopReason.TOOL_USE,
        toolCalls: [
          toolCall('create_task', {
            title: 'Morning workout',
            startAt: '2026-06-25T09:00:00',
            endAt: '2026-06-25T09:45:00',
          }),
        ],
      }),
      completion({
        stopReason: AiStopReason.TOOL_USE,
        toolCalls: [
          toolCall('list_tasks', {
            from: '2026-06-25T00:00:00.000Z',
            to: '2026-06-26T00:00:00.000Z',
          }),
        ],
      }),
      completion({
        stopReason: AiStopReason.END_TURN,
        text: 'Added your 9am workout.',
      }),
    ]);

    await harness.postWebhook(
      harness.buildTextUpdate(fixtures.chatId, 'add a 9am workout today'),
    );

    const reply = await nextAnswer();

    expect(reply.method).toBe('sendMessage');

    // Rendered line shows 09:00 (NOT 12:00 = +3h), read off the tool audit.
    const agenda = await lastRenderedAgenda();

    expect(agenda).toContain('09:00');
    expect(agenda).toContain('09:00–09:45');
    expect(agenda).not.toContain('12:00');

    // The DB stores the absolute instant 06:00Z (09:00 MSK).
    const instants = await harness.listTaskInstants(fixtures.calendar.id);

    expect(instants).toHaveLength(1);
    expect(instants[0].startAt).toBe('2026-06-25T06:00:00.000Z');
    expect(instants[0].endAt).toBe('2026-06-25T06:45:00.000Z');
  });

  it('ONE-OFF update with a naive move localizes in Moscow (reads back 16:00, DB is 13:00Z)', async () => {
    // Round 1: create a one-off at a naive 09:00. Round 2: list for a handle (e1).
    // Round 3: update_task (NOT recurring ⇒ no editScope) moving start to a naive
    // 16:00. Round 4: list the day to read the moved render. Round 5: confirm.
    harness.scriptedAi.script([
      completion({
        stopReason: AiStopReason.TOOL_USE,
        toolCalls: [
          toolCall('create_task', {
            title: 'Dentist',
            startAt: '2026-06-25T09:00:00',
            endAt: '2026-06-25T10:00:00',
          }),
        ],
      }),
      completion({
        stopReason: AiStopReason.TOOL_USE,
        toolCalls: [
          toolCall('list_tasks', {
            from: '2026-06-25T00:00:00.000Z',
            to: '2026-06-26T00:00:00.000Z',
          }),
        ],
      }),
      completion({
        stopReason: AiStopReason.TOOL_USE,
        toolCalls: [
          toolCall('update_task', {
            handle: 'e1',
            startAt: '2026-06-25T16:00:00',
            endAt: '2026-06-25T17:00:00',
          }),
        ],
      }),
      completion({
        stopReason: AiStopReason.TOOL_USE,
        toolCalls: [
          toolCall('list_tasks', {
            from: '2026-06-25T00:00:00.000Z',
            to: '2026-06-26T00:00:00.000Z',
          }),
        ],
      }),
      completion({
        stopReason: AiStopReason.END_TURN,
        text: 'Moved your dentist to 16:00.',
      }),
    ]);

    await harness.postWebhook(
      harness.buildTextUpdate(fixtures.chatId, 'move my dentist to 4pm'),
    );

    const reply = await nextAnswer();

    expect(reply.method).toBe('sendMessage');

    // Rendered post-move line shows 16:00 (NOT 19:00 = +3h).
    const agenda = await lastRenderedAgenda();

    expect(agenda).toContain('16:00–17:00');
    expect(agenda).not.toContain('19:00');

    // DB master stores 13:00Z (16:00 MSK).
    const instants = await harness.listTaskInstants(fixtures.calendar.id);

    expect(instants).toHaveLength(1);
    expect(instants[0].title).toBe('Dentist');
    expect(instants[0].startAt).toBe('2026-06-25T13:00:00.000Z');
    expect(instants[0].endAt).toBe('2026-06-25T14:00:00.000Z');
  });

  it('a string WITH an explicit +03:00 offset round-trips (the offset is honored, NOT re-shifted)', async () => {
    // A create whose startAt CARRIES the Moscow offset (+03:00) denotes the SAME
    // instant as the naive Moscow 14:30 — 11:30Z. The fix must HONOR the in-string
    // offset (luxon only falls back to the zone option for offset-less inputs), so
    // it must not be double-shifted. Reads back 14:30 in the Moscow render.
    harness.scriptedAi.script([
      completion({
        stopReason: AiStopReason.TOOL_USE,
        toolCalls: [
          toolCall('create_task', {
            title: 'Sync',
            startAt: '2026-06-25T14:30:00+03:00',
            endAt: '2026-06-25T15:30:00+03:00',
          }),
        ],
      }),
      completion({
        stopReason: AiStopReason.TOOL_USE,
        toolCalls: [
          toolCall('list_tasks', {
            from: '2026-06-25T00:00:00.000Z',
            to: '2026-06-26T00:00:00.000Z',
          }),
        ],
      }),
      completion({
        stopReason: AiStopReason.END_TURN,
        text: 'Booked your sync at 14:30.',
      }),
    ]);

    await harness.postWebhook(
      harness.buildTextUpdate(fixtures.chatId, 'book a sync at 14:30 today'),
    );

    const reply = await nextAnswer();

    expect(reply.method).toBe('sendMessage');

    // 14:30 in the Moscow render — the explicit +03:00 offset already denotes
    // 11:30Z, so the render must NOT show 17:30 (which a double-shift would yield).
    const agenda = await lastRenderedAgenda();

    expect(agenda).toContain('14:30–15:30');
    expect(agenda).not.toContain('17:30');

    // DB stores the same absolute instant the offset denoted: 11:30Z.
    const instants = await harness.listTaskInstants(fixtures.calendar.id);

    expect(instants).toHaveLength(1);
    expect(instants[0].startAt).toBe('2026-06-25T11:30:00.000Z');
    expect(instants[0].endAt).toBe('2026-06-25T12:30:00.000Z');
  });
});
