import { CapturedSend } from './e2e/capturing-vendor.connector';
import { E2eHarness, SeededFixtures } from './e2e/harness';

/**
 * Whether the real-LLM smokes should run: opt-in via `E2E_LLM=real` AND a
 * plausibly real `ANTHROPIC_API_KEY` (not the placeholder in `.env.test`). When
 * either is missing, the whole describe is skipped so the default/CI e2e run
 * stays deterministic, offline, and free.
 */
const apiKey = process.env.ANTHROPIC_API_KEY ?? '';
const runRealLlm =
  process.env.E2E_LLM === 'real' &&
  apiKey.length > 0 &&
  !apiKey.startsWith('e2e-test-');

const describeRealLlm = runRealLlm ? describe : describe.skip;

/**
 * OPT-IN real-Anthropic smokes. These keep the REAL AnthropicAiConnector (no AI
 * override) and capture only the vendor, so a posted webhook drives a genuine
 * model turn through the full pipeline into Postgres. Inherently nondeterministic
 * (date parsing, wording, tz), so assertions are LOOSE (a row exists, a plausible
 * start window) — never exact strings. Few and slow by design; the timeout is
 * raised for the real network round-trip.
 */
describeRealLlm('Assistant pipeline (real Anthropic smoke)', () => {
  let harness: E2eHarness;
  let fixtures: SeededFixtures;

  /** 60s: a real multi-round tool turn against Anthropic plus DB writes. */
  const REAL_LLM_TIMEOUT_MS = 60_000;

  beforeAll(async () => {
    harness = await E2eHarness.boot({ useRealLlm: true });
  }, REAL_LLM_TIMEOUT_MS);

  afterAll(async () => {
    if (harness) {
      await harness.close();
    }
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

  it(
    'creates a dentist appointment for tomorrow at 3pm',
    async () => {
      await harness.postWebhook(
        harness.buildTextUpdate(
          fixtures.chatId,
          'create a dentist appointment tomorrow at 3pm',
        ),
      );

      // Drain captured sends until the terminal text reply (the model may emit
      // intermediate sends; the final sendMessage is the confirmation).
      let reply = await harness.vendor.nextSend();

      while (reply.method !== 'sendMessage') {
        reply = await harness.vendor.nextSend();
      }

      expect(replyTextOf(reply).length).toBeGreaterThan(0);

      // A task landed in the user's calendar with a plausible start time
      // (tomorrow ~15:00 in the user's UTC tz). Loose window: today→+2 days.
      const tasks = await harness.listTasks(fixtures.calendar.id);

      expect(tasks.length).toBeGreaterThanOrEqual(1);

      const timed = tasks.find((task) => task.startAt !== null);

      expect(timed).toBeDefined();

      const startMs = new Date(timed!.startAt as string).getTime();
      const now = Date.now();

      expect(startMs).toBeGreaterThan(now);
      expect(startMs).toBeLessThan(now + 3 * 24 * 60 * 60 * 1000);
      // Tomorrow at 15:00 UTC → hour-of-day should be 15 (user tz is UTC).
      expect(new Date(timed!.startAt as string).getUTCHours()).toBe(15);
    },
    REAL_LLM_TIMEOUT_MS,
  );

  it(
    'answers a pure schedule read without creating anything',
    async () => {
      const before = await harness.countTasks(fixtures.calendar.id);

      await harness.postWebhook(
        harness.buildTextUpdate(
          fixtures.chatId,
          "what's on my schedule tomorrow?",
        ),
      );

      let reply = await harness.vendor.nextSend();

      while (reply.method !== 'sendMessage') {
        reply = await harness.vendor.nextSend();
      }

      expect(replyTextOf(reply).length).toBeGreaterThan(0);

      // A read must not write.
      const after = await harness.countTasks(fixtures.calendar.id);

      expect(after).toBe(before);
    },
    REAL_LLM_TIMEOUT_MS,
  );
});
