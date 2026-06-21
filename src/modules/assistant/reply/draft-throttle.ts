/**
 * Central L9 draft-update throttle (ADR 0012 / Corrected Assumption 4).
 *
 * Telegram's `sendMessageDraft` re-call rate limit is **undocumented**, so every
 * draft caller (Story 12 status animation, Story 13 streaming) must route its
 * draft updates through ONE conservative cap (~2–5/s) placed here in the egress
 * layer, rather than each caller inventing its own cadence. This module owns the
 * cap as a tiny, dependency-free token-style limiter so future draft callers
 * inherit it for free.
 *
 * The throttle is **coalescing, not queueing**: when calls arrive faster than the
 * cap it keeps only the LATEST pending update (a draft is a full-text replacement,
 * so an older partial is always superseded by a newer one) and flushes it when the
 * window opens. This guarantees the final state is always sent without buffering a
 * backlog of stale intermediate frames.
 */

/** Default cap: 4 draft updates/second — the midpoint of the ADR 0012 ~2–5/s band. */
export const DEFAULT_DRAFT_UPDATES_PER_SECOND = 4;

/** One draft-update job: performs the actual vendor send for the latest text. */
export type DraftUpdateJob = () => Promise<void>;

/**
 * A leading-edge + trailing-coalescing rate limiter for draft updates. Run the
 * first job immediately, then admit at most one job per `minIntervalMs`; while
 * the window is closed only the most recent job is retained and fired when the
 * window reopens. Not Redis-backed — a draft animation is per-turn and in-process,
 * so an in-memory limiter is the right scope (one instance per live status/stream).
 */
export class DraftThrottle {
  private readonly minIntervalMs: number;

  // -Infinity so the very first submit is always treated as leading-edge
  // (elapsed = now - (-Infinity) = Infinity ≥ minIntervalMs), independent of the
  // injected clock's starting value.
  private lastRunAt = Number.NEGATIVE_INFINITY;

  private pendingJob: DraftUpdateJob | null = null;

  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * @param updatesPerSecond Cap on draft sends per second (clamped to the ADR
   *   0012 ~2–5/s band). Defaults to {@link DEFAULT_DRAFT_UPDATES_PER_SECOND}.
   * @param now Injectable clock (ms) for deterministic tests; defaults to
   *   `Date.now`.
   */
  constructor(
    updatesPerSecond: number = DEFAULT_DRAFT_UPDATES_PER_SECOND,
    private readonly now: () => number = Date.now,
  ) {
    const clamped = Math.min(5, Math.max(2, updatesPerSecond));

    this.minIntervalMs = Math.ceil(1000 / clamped);
  }

  /**
   * Clears any scheduled trailing flush. Internal helper so both an immediate run
   * and {@link cancel} can drop the timer without leaking a handle.
   */
  private clearFlushTimer(): void {
    if (!this.flushTimer) {
      return;
    }

    clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }

  /**
   * Runs a job now, stamping the window. Swallows the job's own rejection so a
   * single failed draft send never tears down the animation loop (the egress
   * layer's "every turn must answer" posture); the next update simply tries again.
   */
  private async runNow(job: DraftUpdateJob): Promise<void> {
    this.lastRunAt = this.now();

    try {
      await job();
    } catch {
      // A failed draft frame is non-fatal — the next coalesced update supersedes it.
    }
  }

  /**
   * Submits a draft-update job. If the window is open it runs immediately
   * (leading edge); otherwise it REPLACES any pending job (coalescing — the
   * latest full-text draft wins) and schedules a single trailing flush at the
   * window boundary. Returns once the job has been run or accepted as pending.
   */
  async submit(job: DraftUpdateJob): Promise<void> {
    const elapsed = this.now() - this.lastRunAt;

    if (elapsed >= this.minIntervalMs && !this.flushTimer) {
      await this.runNow(job);

      return;
    }

    // Window closed (or a flush is already armed): keep only the newest job.
    this.pendingJob = job;

    if (this.flushTimer) {
      return;
    }

    const wait = Math.max(0, this.minIntervalMs - elapsed);

    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;

      const next = this.pendingJob;

      this.pendingJob = null;

      if (next) {
        void this.runNow(next);
      }
    }, wait);
  }

  /**
   * Cancels any pending trailing flush and drops the retained job. MUST be called
   * in the caller's `finally` so a turn that ends mid-animation leaves no timer
   * handle behind (timer-leak guard, ADR 0012).
   */
  cancel(): void {
    this.clearFlushTimer();
    this.pendingJob = null;
  }
}
