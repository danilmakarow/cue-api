import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

import { CapturedSend } from './e2e/capturing-vendor.connector';
import { E2eHarness, SeededFixtures } from './e2e/harness';
import { completion, toolCall } from './e2e/scripted-ai.connector';
import { AiStopReason } from '@/modules/ai/ai.types';
import { AssistantConfig } from '@/modules/assistant/assistant.config';
import { DebounceQueueJob } from '@/modules/assistant/assistant.types';
import { UserLockStore } from '@/modules/assistant/session/user-lock.store';
import { DEBOUNCE_QUEUE_NAME } from '@/modules/redis/redis.constants';

/**
 * FIX 1 PROOF (real BullMQ) — queue-after must arm a drain job that ACTUALLY runs
 * the queued batch after the in-flight turn completes, with NO further inbound.
 *
 * The hazard the old code had: the queue-after re-arm fired from INSIDE the
 * still-active drain job and re-used the STABLE window jobId via remove-then-add.
 * Under real BullMQ 5.x, `remove()` on the ACTIVE job is a no-op and `add()` with
 * an existing jobId is IGNORED, so NO drain job was actually armed for the
 * re-buffered batch — the queued-after turn STALLED until the user sent another
 * message. The fix arms a FRESH UNIQUE jobId (`debounce-after-{user}-{nonce}`)
 * that BullMQ genuinely creates, so the re-poll fires and runs the batch.
 *
 * This test boots the WHOLE app against the local docker Postgres + Redis with
 * the real in-process BullMQ worker. To simulate an in-flight turn WITHOUT
 * monopolizing the lone debounce `@Processor` worker (concurrency 1), it HOLDS
 * THE PER-USER LOCK DIRECTLY via {@link UserLockStore} — acquired by the TEST,
 * not by a gated worker job. That distinction is the whole point: with the lock
 * held by something OTHER than the debounce worker, the worker slot stays FREE,
 * so a message's drain job can actually run, find the lock held, and queue-after.
 *
 * Flow: hold the user lock → post a message → let its debounce window fire so its
 * drain job runs on the (free) worker → the drain finds the lock held → queue
 * -after → {@link armAfter} creates a fresh `debounce-after-*` job (asserted to
 * exist) → release the held lock → the after-job fires and the queued batch's
 * turn actually runs and replies — all with NO extra inbound.
 *
 * Against the PRE-FIX code (stable-id remove-then-add from inside the active job)
 * this test FAILS at the `debounce-after-*` assertion: no fresh re-poll job is
 * created (the stable-id re-add is ignored), so the queued batch has no armed
 * drain, the second reply never arrives, and `nextSend()` times out. Against the
 * fixed `armAfter` (unique per-arm jobId) it PASSES. It is therefore a real
 * regression guard for FIX 1.
 */
describe('Debounce queue-after under REAL BullMQ (FIX 1)', () => {
  let harness: E2eHarness;
  let fixtures: SeededFixtures;
  let debounceQueue: Queue<DebounceQueueJob>;
  let userLock: UserLockStore;
  let windowMs: number;

  beforeAll(async () => {
    harness = await E2eHarness.boot();
    debounceQueue = harness.moduleRef.get<Queue<DebounceQueueJob>>(
      getQueueToken(DEBOUNCE_QUEUE_NAME),
    );
    userLock = harness.moduleRef.get(UserLockStore);

    const config = harness.moduleRef.get(AssistantConfig);

    windowMs = config.debounceWindowMs;
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    fixtures = await harness.seedLinkedUser();
  });

  afterEach(async () => {
    await harness.settleBackground();
    // Drain any leftover delayed/waiting debounce jobs so they never bleed into
    // the next scenario, then the harness reset flushes the DB + Redis.
    await debounceQueue.drain(true);
    await harness.reset();
  });

  /** Reads the text off a captured `sendMessage`. */
  const replyTextOf = (send: CapturedSend): string =>
    (send.payload as { text: string }).text;

  /** Sleeps for `ms` — used to let a real debounce WINDOW elapse + the drain fire. */
  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

  it('runs the queued-after message AFTER the held lock frees, via a fresh queue-after job, with NO further inbound', async () => {
    // The QUEUED-AFTER turn: round 1 calls create_task, round 2 confirms. This is
    // the only turn that runs in this scenario — the "in-flight turn" is simulated
    // by directly holding the per-user lock, so no model rounds are spent on it.
    harness.scriptedAi.script([
      completion({
        stopReason: AiStopReason.TOOL_USE,
        toolCalls: [toolCall('create_task', { title: 'second task' })],
      }),
      completion({
        stopReason: AiStopReason.END_TURN,
        text: 'Done — added "second task".',
      }),
    ]);

    // Simulate an in-flight turn by HOLDING the per-user lock DIRECTLY (with the
    // watchdog, so its TTL is renewed and it never auto-expires while held). Held
    // by the TEST — not by a gated debounce worker job — so the lone debounce
    // worker slot stays FREE to pick up the message's drain job below.
    const lockHandle = await userLock.acquireWithWatchdog(fixtures.user.id);

    expect(lockHandle).not.toBeNull();

    if (!lockHandle) {
      throw new Error('Could not acquire the per-user lock to seed the test.');
    }

    // The message arrives while the lock is held. It buffers into its debounce
    // window and arms its drain job (delay ~windowMs).
    await harness.postWebhook(
      harness.buildTextUpdate(fixtures.chatId, 'add second task'),
    );

    // Let the debounce window elapse so the drain job FIRES while the lock is still
    // held. The drain runs on the free worker, drains the buffer, finds the lock
    // held → queue-after. Wait window + a margin (but the held lock keeps the turn
    // from running, so the re-poll only ARMS here, it does not yet run).
    await sleep(windowMs + 500);

    // PROOF the re-poll was actually scheduled under real BullMQ: a FRESH unique
    // queue-after job exists (id `debounce-after-{user}-{nonce}`) carrying this
    // user. The pre-fix code would have created NOTHING here (a stable-id re-add on
    // the active job is ignored), leaving the batch with no armed drain.
    const delayedJobs = await debounceQueue.getDelayed();
    const queueAfterJobs = delayedJobs.filter((job) =>
      (job.id ?? '').startsWith(`debounce-after-${fixtures.user.id}-`),
    );

    expect(queueAfterJobs.length).toBeGreaterThanOrEqual(1);

    // No substantive reply has been sent yet — the lock is still held, so the
    // queued-after turn cannot have run. Release the lock: the queue-after job
    // re-polls (~queueAfterMs out), now finds the lock FREE, and runs the batch
    // with NO extra inbound.
    await userLock.releaseHandle(lockHandle);

    // The queued-after turn's confirmation — driven ONLY by the queue-after re-poll
    // (no second webhook was posted).
    const reply = await harness.vendor.nextSend();

    expect(reply.method).toBe('sendMessage');
    expect(replyTextOf(reply)).toMatch(/second task/i);

    // The write committed — the queued-after turn really ran after the lock freed.
    const tasks = await harness.listTasks(fixtures.calendar.id);

    expect(tasks.map((task) => task.title)).toEqual(['second task']);
  }, 25000);
});
