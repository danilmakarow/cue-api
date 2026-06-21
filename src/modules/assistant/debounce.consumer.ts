import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';

import { DebounceQueueJob } from './assistant.types';
import { DebounceCoordinatorService } from './session/debounce-coordinator.service';
import { DEBOUNCE_QUEUE_NAME } from '../redis/redis.constants';
import { UserDatabaseService } from '@/modules/database/services';

/**
 * BullMQ consumer for the per-user debounce-drain job (Story 14a / ADR 0042).
 * The job is a single delayed job per user (stable `jobId`), fired ~2 s after the
 * LAST inbound in the user's window; on fire it resolves the {@link User} and
 * hands off to {@link DebounceCoordinatorService.drainAndRun}, which drains the
 * Redis buffer, combines the window's messages into ONE turn, and runs it under
 * the per-user lock (queue-after when a turn is in flight).
 *
 * `attempts:1` (per-queue override of the global `attempts:5`, ADR-0026) — like
 * the inbound webhook queue, a drained turn commits non-idempotent calendar
 * writes, so a replay would double-book. The coordinator therefore degrades
 * never-throw: a fault re-buffers the batch (it is never dropped) rather than
 * relying on a retry. A missing user/link is a no-op (the linking prompt is the
 * inbound path's job, not the drain's).
 */
@Processor(DEBOUNCE_QUEUE_NAME)
export class DebounceConsumer extends WorkerHost {
  private readonly logger = new Logger(DebounceConsumer.name);

  constructor(
    private readonly userDatabaseService: UserDatabaseService,
    private readonly coordinator: DebounceCoordinatorService,
  ) {
    super();
  }

  /**
   * Processes one debounce-drain job: resolves the user, then drains + runs the
   * combined turn. A vanished user is a no-op (nothing to run). Any other fault
   * is left to the coordinator's never-throw re-buffering; this method only
   * guards the user lookup so a transient DB blip does not lose the buffer (the
   * buffered messages survive — a follow-up inbound or the next drain re-runs).
   */
  async process(job: Job<DebounceQueueJob>): Promise<void> {
    const { userId } = job.data;
    const user = await this.userDatabaseService.findOneBy({ id: userId });

    if (!user) {
      this.logger.warn(
        `Debounce drain for missing user ${userId}; skipping (buffer left intact).`,
      );

      return;
    }

    await this.coordinator.drainAndRun(user, job.data);
  }

  /**
   * Logs a failed drain job so a drop is never silent. Under `attempts:1` this is
   * the job's single terminal attempt — the coordinator's never-throw path means
   * reaching here is a true infra fault (e.g. the user lookup threw), with the
   * buffered messages still intact for a later drain.
   */
  @OnWorkerEvent('failed')
  onFailed(job: Job<DebounceQueueJob> | undefined, error: Error): void {
    this.logger.error(
      `Debounce drain job ${job?.id ?? 'unknown'} (user ${
        job?.data?.userId ?? 'unknown'
      }) failed: ${error.message}`,
    );
  }
}
