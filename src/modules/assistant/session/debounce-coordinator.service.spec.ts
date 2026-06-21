import { DebounceCoordinatorService } from './debounce-coordinator.service';
import { BufferedMessage } from './message-buffer.store';
import { debounceJobId } from '../../redis/redis.constants';
import { DebounceAnswerPayload } from '../assistant.types';
import { User } from '@/modules/database/entities';
import { InboundKind } from '@/modules/external-vendor/external-vendor.types';

/**
 * In-memory stand-in for {@link MessageBufferStore}: a per-user array that models
 * arrival-order append / atomic drain / front-requeue, so combine-order and the
 * queue-after re-buffering can be asserted for real.
 */
const buildBufferFake = () => {
  const buffers = new Map<string, BufferedMessage[]>();

  return {
    buffers,
    store: {
      append: jest.fn(async (userId: string, message: BufferedMessage) => {
        const list = buffers.get(userId) ?? [];

        list.push(message);
        buffers.set(userId, list);

        return list.length;
      }),
      drain: jest.fn(async (userId: string): Promise<BufferedMessage[]> => {
        const list = buffers.get(userId) ?? [];

        buffers.delete(userId);

        return list;
      }),
      requeueFront: jest.fn(
        async (userId: string, messages: BufferedMessage[]) => {
          const list = buffers.get(userId) ?? [];

          buffers.set(userId, [...messages, ...list]);
        },
      ),
    },
  };
};

/**
 * One captured `add` call against the fake queue.
 */
interface ArmedJob {
  jobId: string;
  delay: number;
  data: { userId: string; answer?: unknown };
}

/**
 * A fake BullMQ queue tracking the currently-armed delayed job per jobId AND the
 * full add-call history. The STABLE window jobId re-arm is observable as the new
 * delay (remove + add); the queue-after path arms a UNIQUE jobId per call (FIX 1),
 * so `addHistory` is what those assertions inspect (real BullMQ would IGNORE a
 * re-add of the active job's id — this fake deliberately does NOT auto-delete on
 * remove(), so the queue-after must not depend on remove()).
 */
const buildQueueFake = () => {
  const armed = new Map<string, { delay: number; addCount: number }>();
  const addHistory: ArmedJob[] = [];

  return {
    armed,
    addHistory,
    queue: {
      remove: jest.fn(async (jobId: string) => {
        armed.delete(jobId);
      }),
      add: jest.fn(
        async (
          _name: string,
          data: { userId: string; answer?: unknown },
          opts: { jobId: string; delay: number },
        ) => {
          const existing = armed.get(opts.jobId);

          armed.set(opts.jobId, {
            delay: opts.delay,
            addCount: (existing?.addCount ?? 0) + 1,
          });
          addHistory.push({ jobId: opts.jobId, delay: opts.delay, data });
        },
      ),
    },
  };
};

/**
 * A user-lock fake whose `held` flag decides whether `runExclusive` runs `work`
 * (lock free) or returns `onBusy()` (a turn already in flight) — the queue-after
 * trigger. Tracks concurrency so "never concurrent" can be asserted.
 */
const buildLockFake = (held = false) => {
  let inFlight = 0;
  let maxConcurrent = 0;

  return {
    setHeld: (value: boolean) => {
      held = value;
    },
    get maxConcurrent() {
      return maxConcurrent;
    },
    lock: {
      runExclusive: jest.fn(
        async <T>(
          _userId: string,
          work: () => Promise<T>,
          onBusy: () => T,
        ): Promise<T> => {
          if (held) {
            return onBusy();
          }

          inFlight += 1;
          maxConcurrent = Math.max(maxConcurrent, inFlight);

          try {
            return await work();
          } finally {
            inFlight -= 1;
          }
        },
      ),
    },
  };
};

const buildCoordinator = (lockHeld = false) => {
  const buffer = buildBufferFake();
  const queue = buildQueueFake();
  const lock = buildLockFake(lockHeld);
  const turnRunner = {
    runFromMessage: jest.fn().mockResolvedValue(undefined),
  };
  const config = {
    debounceWindowMs: 2000,
    debounceQueueAfterMs: 750,
  };

  const coordinator = new DebounceCoordinatorService(
    queue.queue as never,
    buffer.store as never,
    lock.lock as never,
    turnRunner as never,
    config as never,
  );

  return { coordinator, buffer, queue, lock, turnRunner, config };
};

const message = (text: string, kind = InboundKind.Text): BufferedMessage => ({
  text,
  kind,
  vendorChatId: 'chat-1',
  correlationId: 'cid-1',
  chatType: undefined,
  languageCode: 'en',
});

const USER = { id: 'user-1', timezone: 'UTC' } as User;

describe('DebounceCoordinatorService (debounce + combine + queue-after, ADR 0042)', () => {
  it('buffer appends the message and arms the delayed drain job at the window', async () => {
    const { coordinator, buffer, queue, config } = buildCoordinator();

    await coordinator.buffer(USER.id, message('hello'));

    expect(buffer.buffers.get(USER.id)).toHaveLength(1);
    expect(queue.armed.get(debounceJobId(USER.id))?.delay).toBe(
      config.debounceWindowMs,
    );
  });

  it('window re-arm: each new inbound removes the pending job and re-adds it (timer slides)', async () => {
    const { coordinator, queue, buffer } = buildCoordinator();

    await coordinator.buffer(USER.id, message('one'));
    await coordinator.buffer(USER.id, message('two'));
    await coordinator.buffer(USER.id, message('three'));

    // The pending job was removed before each re-add — sliding the window to the
    // latest message rather than letting the original (earlier) timer stand.
    expect(queue.queue.remove).toHaveBeenCalledTimes(3);
    expect(queue.queue.add).toHaveBeenCalledTimes(3);
    // All three messages are buffered (none dropped under rapid arrival).
    expect(buffer.buffers.get(USER.id)?.map((m) => m.text)).toEqual([
      'one',
      'two',
      'three',
    ]);
  });

  it('drainAndRun combines window messages by concatenation in arrival order, ONE turn', async () => {
    const { coordinator, turnRunner } = buildCoordinator();

    await coordinator.buffer(USER.id, message('book dentist tuesday'));
    await coordinator.buffer(USER.id, message('actually wednesday'));
    await coordinator.buffer(USER.id, message('and also the gym'));

    await coordinator.drainAndRun(USER);

    expect(turnRunner.runFromMessage).toHaveBeenCalledTimes(1);
    expect(turnRunner.runFromMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'book dentist tuesday\nactually wednesday\nand also the gym',
        origin: 'simple_message',
        correlationId: 'cid-1',
        vendorChatId: 'chat-1',
      }),
    );
  });

  it('a window mixing in a voice transcript is persisted as a voice transcript', async () => {
    const { coordinator, turnRunner } = buildCoordinator();

    await coordinator.buffer(USER.id, message('typed part', InboundKind.Text));
    await coordinator.buffer(
      USER.id,
      message('spoken part', InboundKind.Voice),
    );

    await coordinator.drainAndRun(USER);

    expect(turnRunner.runFromMessage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: InboundKind.Voice }),
    );
  });

  it('queue-after: a drain while a turn is in flight re-buffers the batch and arms a FRESH unique job (never concurrent, never reuses the active stable id)', async () => {
    const { coordinator, buffer, queue, lock, turnRunner, config } =
      buildCoordinator(true);

    await coordinator.buffer(USER.id, message('mid-turn message'));
    // Buffering also armed the window; clear that so we observe only the queue-after arm.
    queue.queue.add.mockClear();
    queue.queue.remove.mockClear();
    queue.addHistory.length = 0;

    await coordinator.drainAndRun(USER);

    // The turn never ran concurrently — the in-flight lock deferred it.
    expect(turnRunner.runFromMessage).not.toHaveBeenCalled();
    expect(lock.maxConcurrent).toBe(0);
    // The batch is re-buffered (NOT dropped).
    expect(buffer.buffers.get(USER.id)?.map((m) => m.text)).toEqual([
      'mid-turn message',
    ]);
    // FIX 1: the queue-after arm fired from INSIDE the active drain job, so it must
    // NOT reuse the stable window jobId (real BullMQ would ignore an add() for the
    // active job's id) and must NOT rely on remove(). It arms exactly one FRESH
    // unique job (a `debounce-after-{user}-{nonce}` id) at the short delay.
    expect(queue.queue.remove).not.toHaveBeenCalled();
    expect(queue.addHistory).toHaveLength(1);
    expect(queue.addHistory[0].jobId).not.toBe(debounceJobId(USER.id));
    expect(queue.addHistory[0].jobId).toMatch(
      new RegExp(`^debounce-after-${USER.id}-`),
    );
    expect(queue.addHistory[0].delay).toBe(config.debounceQueueAfterMs);
    // A simple-message queue-after carries no answer payload (the batch is in the buffer).
    expect(queue.addHistory[0].data.answer).toBeUndefined();
  });

  it('queued-after batch runs AFTER the in-flight turn frees the lock (runs, in order, once)', async () => {
    const { coordinator, buffer, lock, turnRunner } = buildCoordinator(true);

    await coordinator.buffer(USER.id, message('first'));
    await coordinator.buffer(USER.id, message('second'));

    // First drain: lock held → queue-after (re-buffered).
    await coordinator.drainAndRun(USER);

    expect(turnRunner.runFromMessage).not.toHaveBeenCalled();
    expect(buffer.buffers.get(USER.id)?.map((m) => m.text)).toEqual([
      'first',
      'second',
    ]);

    // The in-flight turn completes — the lock frees.
    lock.setHeld(false);

    // The re-armed drain fires: now it runs the combined batch exactly once.
    await coordinator.drainAndRun(USER);

    expect(turnRunner.runFromMessage).toHaveBeenCalledTimes(1);
    expect(turnRunner.runFromMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'first\nsecond' }),
    );
    // Buffer is now empty — nothing left over, nothing dropped.
    expect(buffer.buffers.get(USER.id)).toBeUndefined();
  });

  it('an empty drain is a no-op (no turn, no re-arm)', async () => {
    const { coordinator, turnRunner, queue } = buildCoordinator();

    await coordinator.drainAndRun(USER);

    expect(turnRunner.runFromMessage).not.toHaveBeenCalled();
    expect(queue.queue.add).not.toHaveBeenCalled();
  });

  it('degrade: a turn fault re-buffers the batch instead of dropping it, never throws', async () => {
    const { coordinator, buffer, turnRunner } = buildCoordinator();

    turnRunner.runFromMessage.mockRejectedValue(new Error('infra down'));

    await coordinator.buffer(USER.id, message('important task'));

    // The drain must NOT throw (debounce queue is attempts:1) ...
    await expect(coordinator.drainAndRun(USER)).resolves.toBeUndefined();

    // ... and the batch is re-buffered for a later drain, never silently dropped.
    expect(buffer.buffers.get(USER.id)?.map((m) => m.text)).toEqual([
      'important task',
    ]);
  });

  it('a re-arm whose queue remove faults still arms the job (degrade-never-throw)', async () => {
    const { coordinator, queue } = buildCoordinator();

    queue.queue.remove.mockRejectedValueOnce(new Error('redis blip'));

    await expect(coordinator.buffer(USER.id, message('hi'))).resolves.toBe(
      true,
    );

    expect(queue.queue.add).toHaveBeenCalledTimes(1);
  });

  it('buffer returns true for the FIRST entry and false thereafter (FIX 3 voice-seed signal)', async () => {
    const { coordinator } = buildCoordinator();

    await expect(coordinator.buffer(USER.id, message('one'))).resolves.toBe(
      true,
    );
    await expect(coordinator.buffer(USER.id, message('two'))).resolves.toBe(
      false,
    );
    await expect(coordinator.buffer(USER.id, message('three'))).resolves.toBe(
      false,
    );
  });

  const answer = (
    over: Partial<DebounceAnswerPayload> = {},
  ): DebounceAnswerPayload => ({
    text: 'Tuesday',
    kind: InboundKind.Text,
    vendorChatId: 'chat-1',
    correlationId: 'cid-answer',
    origin: 'answer_callback',
    callbackId: 'cb-1',
    chatType: undefined,
    languageCode: 'en',
    ...over,
  });

  describe('ask_user answer path serialization (FIX 2)', () => {
    it('runs the answer turn UNDER the per-user lock (never concurrent with a simple-message turn)', async () => {
      const { coordinator, lock, turnRunner } = buildCoordinator();

      await coordinator.runAnswerExclusive(USER, answer());

      // The answer ran through the SAME lock primitive (not bypassing it).
      expect(lock.lock.runExclusive).toHaveBeenCalledTimes(1);
      expect(lock.maxConcurrent).toBe(1);
      expect(turnRunner.runFromMessage).toHaveBeenCalledTimes(1);
      expect(turnRunner.runFromMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: 'Tuesday',
          origin: 'answer_callback',
          callbackId: 'cb-1',
          correlationId: 'cid-answer',
        }),
      );
    });

    it('an answer arriving mid-turn (lock held) queues-after a FRESH unique job carrying the answer, never running concurrently', async () => {
      const { coordinator, queue, lock, turnRunner, config } =
        buildCoordinator(true);

      await coordinator.runAnswerExclusive(USER, answer());

      // It did NOT run concurrently with the in-flight turn.
      expect(turnRunner.runFromMessage).not.toHaveBeenCalled();
      expect(lock.maxConcurrent).toBe(0);
      // It queued-after via a fresh unique job that RE-CARRIES the answer payload
      // (an answer is never buffered/combined), at the short delay.
      expect(queue.addHistory).toHaveLength(1);
      expect(queue.addHistory[0].jobId).toMatch(
        new RegExp(`^debounce-after-${USER.id}-`),
      );
      expect(queue.addHistory[0].delay).toBe(config.debounceQueueAfterMs);
      expect(queue.addHistory[0].data.answer).toEqual(
        expect.objectContaining({ text: 'Tuesday', origin: 'answer_callback' }),
      );
    });

    it('a queued-after answer job (job.answer present) re-runs the answer turn once the lock is free', async () => {
      const { coordinator, lock, turnRunner } = buildCoordinator(true);

      // First attempt: lock held → queued-after (no run).
      await coordinator.runAnswerExclusive(USER, answer());

      expect(turnRunner.runFromMessage).not.toHaveBeenCalled();

      // The in-flight turn completes; the re-armed job fires through drainAndRun
      // carrying the answer payload.
      lock.setHeld(false);

      await coordinator.drainAndRun(USER, {
        userId: USER.id,
        answer: answer(),
      });

      expect(turnRunner.runFromMessage).toHaveBeenCalledTimes(1);
      expect(turnRunner.runFromMessage).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'Tuesday', origin: 'answer_callback' }),
      );
    });

    it('degrade: an answer-turn fault re-queues the answer instead of dropping it, never throws', async () => {
      const { coordinator, queue, turnRunner } = buildCoordinator();

      turnRunner.runFromMessage.mockRejectedValue(new Error('infra down'));

      await expect(
        coordinator.runAnswerExclusive(USER, answer()),
      ).resolves.toBeUndefined();

      expect(queue.addHistory).toHaveLength(1);
      expect(queue.addHistory[0].data.answer).toEqual(
        expect.objectContaining({ text: 'Tuesday' }),
      );
    });
  });
});
