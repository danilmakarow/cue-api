import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { PendingQuestionStatus } from '@/modules/database/entities';
import { PendingQuestionDatabaseService } from '@/modules/database/services';

/**
 * Maximum number of expired `AWAITING` rows one cleanup sweep flips to `EXPIRED`.
 * Bounds the work per run so a large backlog drains over several runs rather than
 * one long transaction; the `(status, expiresAt)` index keeps each scan cheap.
 */
const CLEANUP_BATCH_SIZE = 500;

/**
 * Hygiene sweep for suspended `ask_user` rows (ADR 0010). Correctness is already
 * guaranteed by the atomic claim — a row past its `expiresAt` simply stops being
 * a live answer target. This cron marks those stale `AWAITING` rows `EXPIRED` on
 * a schedule so the open-question table does not accrete dead rows and the
 * partial unique index reflects reality. It NEVER deletes data (the rows remain
 * as history) and never re-invokes the model.
 */
@Injectable()
export class PendingQuestionCleanupService {
  private readonly logger = new Logger(PendingQuestionCleanupService.name);

  constructor(
    private readonly pendingQuestionDatabaseService: PendingQuestionDatabaseService,
  ) {}

  /**
   * Hourly sweep: loads up to {@link CLEANUP_BATCH_SIZE} `AWAITING` rows whose
   * `expiresAt` has passed (oldest first, via the `(status, expiresAt)` index)
   * and flips each to `EXPIRED` through the 3-layer DB service. A row claimed
   * between the read and the write is left alone (its status already moved off
   * `AWAITING`, so the guarded save is a no-op for the stale ones). Swallows its
   * own errors so a transient DB hiccup never crashes the scheduler.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async sweepExpired(): Promise<void> {
    try {
      const expired =
        await this.pendingQuestionDatabaseService.findExpiredAwaiting(
          new Date(),
          CLEANUP_BATCH_SIZE,
        );

      if (expired.length === 0) {
        return;
      }

      for (const row of expired) {
        // Re-check under the row we loaded: only flip a still-AWAITING row, so a
        // concurrent claim that already moved it to ANSWERED is never clobbered.
        if (row.status !== PendingQuestionStatus.AWAITING) {
          continue;
        }

        row.status = PendingQuestionStatus.EXPIRED;

        await this.pendingQuestionDatabaseService.save(row);
      }

      this.logger.log(
        `Expired ${expired.length} stale pending ask_user question(s).`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';

      this.logger.warn(`Pending-question cleanup sweep failed: ${message}`);
    }
  }
}
