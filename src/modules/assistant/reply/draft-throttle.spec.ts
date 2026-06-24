import {
  DEFAULT_DRAFT_UPDATES_PER_SECOND,
  DraftThrottle,
} from './draft-throttle';

/**
 * Drives the throttle with an injectable clock so cadence is deterministic
 * without real time. The clock is a plain mutable holder the tests advance.
 */
const buildClock = () => {
  const state = { now: 0 };

  return {
    state,
    read: () => state.now,
    advance: (ms: number) => {
      state.now += ms;
    },
  };
};

describe('DraftThrottle (L9 draft-update cap, ADR 0012 / Corrected Assumption 4)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('runs the first submitted job immediately (leading edge)', async () => {
    const clock = buildClock();
    const throttle = new DraftThrottle(4, clock.read);
    const job = jest.fn().mockResolvedValue(undefined);

    await throttle.submit(job);

    expect(job).toHaveBeenCalledTimes(1);
  });

  it('caps the rate: a burst inside one window runs the first, defers exactly one trailing flush', async () => {
    const clock = buildClock();
    // 4/s ⇒ 250ms min interval.
    const throttle = new DraftThrottle(4, clock.read);
    const first = jest.fn().mockResolvedValue(undefined);
    const second = jest.fn().mockResolvedValue(undefined);
    const third = jest.fn().mockResolvedValue(undefined);

    await throttle.submit(first); // leading-edge run
    await throttle.submit(second); // window closed → pending
    await throttle.submit(third); // supersedes `second`

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    expect(third).not.toHaveBeenCalled();

    // Advance the clock + fire the trailing flush at the window boundary.
    clock.advance(250);
    await jest.advanceTimersByTimeAsync(250);

    // Only the LATEST pending job ran — the older one was coalesced away.
    expect(third).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it('coalesces to the newest frame: many rapid submits send only first + last', async () => {
    const clock = buildClock();
    const throttle = new DraftThrottle(4, clock.read);
    const jobs = Array.from({ length: 6 }, () =>
      jest.fn().mockResolvedValue(undefined),
    );

    for (const job of jobs) {
      await throttle.submit(job);
    }

    clock.advance(250);
    await jest.advanceTimersByTimeAsync(250);

    expect(jobs[0]).toHaveBeenCalledTimes(1); // leading edge
    expect(jobs[jobs.length - 1]).toHaveBeenCalledTimes(1); // trailing flush

    // Everything in between was superseded.
    for (const middle of jobs.slice(1, -1)) {
      expect(middle).not.toHaveBeenCalled();
    }
  });

  it('admits a fresh leading-edge run once a full window has elapsed', async () => {
    const clock = buildClock();
    const throttle = new DraftThrottle(4, clock.read);
    const first = jest.fn().mockResolvedValue(undefined);
    const second = jest.fn().mockResolvedValue(undefined);

    await throttle.submit(first);
    clock.advance(300); // > 250ms
    await throttle.submit(second);

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('cancel() drops the pending job and clears the timer (no trailing send, timer-leak guard)', async () => {
    const clock = buildClock();
    const throttle = new DraftThrottle(4, clock.read);
    const first = jest.fn().mockResolvedValue(undefined);
    const pending = jest.fn().mockResolvedValue(undefined);

    await throttle.submit(first);
    await throttle.submit(pending); // queued as the trailing flush

    throttle.cancel();

    clock.advance(250);
    await jest.advanceTimersByTimeAsync(250);

    expect(pending).not.toHaveBeenCalled();
    // No timers remain armed after cancel.
    expect(jest.getTimerCount()).toBe(0);
  });

  it('a failing draft frame does not break the loop: a later submit still runs', async () => {
    const clock = buildClock();
    const throttle = new DraftThrottle(4, clock.read);
    const failing = jest.fn().mockRejectedValue(new Error('429'));
    const recovered = jest.fn().mockResolvedValue(undefined);

    // The first (failing) job is awaited internally and its rejection swallowed.
    await throttle.submit(failing);
    expect(failing).toHaveBeenCalledTimes(1);

    clock.advance(300);
    await throttle.submit(recovered);

    expect(recovered).toHaveBeenCalledTimes(1);
  });

  it('clamps the configured rate into the ADR 0012 ~2–5/s band (10/s ⇒ 5/s ⇒ 200ms)', async () => {
    const clock = buildClock();
    const throttle = new DraftThrottle(10, clock.read);
    const first = jest.fn().mockResolvedValue(undefined);
    const second = jest.fn().mockResolvedValue(undefined);

    await throttle.submit(first);
    clock.advance(150); // < 200ms ⇒ still throttled
    await throttle.submit(second);

    expect(second).not.toHaveBeenCalled();

    clock.advance(50); // now 200ms total
    await jest.advanceTimersByTimeAsync(50);

    expect(second).toHaveBeenCalledTimes(1);
  });

  it('exposes a default cap inside the 2–5/s band', () => {
    expect(DEFAULT_DRAFT_UPDATES_PER_SECOND).toBeGreaterThanOrEqual(2);
    expect(DEFAULT_DRAFT_UPDATES_PER_SECOND).toBeLessThanOrEqual(5);
  });
});
