import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DateTime } from 'luxon';

import { ReportGeneratorService } from './report-generator.service';
import { ReportSenderService } from './report-sender.service';
import {
  UserDatabaseService,
  UserReportSettingsDatabaseService,
} from '@/modules/database/services';

/**
 * Per-minute scheduler for the daily notification report (Story 17 / ADR 0046).
 * Once a minute it scans the opted-in (`enabled`) settings rows and, for each,
 * computes the user's LOCAL wall-clock time from `User.timezone` via luxon. When
 * the local `HH:mm` matches `reportTimeLocal` AND the user's local date has not
 * already been sent (`lastSentLocalDate`), it generates ONE report and sends it.
 *
 * **Idempotency.** `lastSentLocalDate` is set to the user's local `YYYY-MM-DD`
 * BEFORE the (interim) send and persisted immediately, so a second scan in the
 * same local minute — or any later minute of the same local day — sees the day
 * already covered and skips. The mark is written only after a report is generated
 * and a delivery succeeds, so an empty report or a missing link leaves the day
 * un-marked and a later minute can retry.
 *
 * **Resilience (degrade-never-throw).** Each user is processed under its own
 * try/catch, so one user's generation/send failure is logged and never aborts the
 * scan for the others. The whole sweep is additionally wrapped so a transient DB
 * hiccup loading the candidate set cannot crash the scheduler.
 */
@Injectable()
export class DailyReportScheduler {
  private readonly logger = new Logger(DailyReportScheduler.name);

  constructor(
    private readonly userReportSettingsDatabaseService: UserReportSettingsDatabaseService,
    private readonly userDatabaseService: UserDatabaseService,
    private readonly reportGeneratorService: ReportGeneratorService,
    private readonly reportSenderService: ReportSenderService,
  ) {}

  /**
   * One per-minute sweep over the opted-in users. Loads the enabled settings rows
   * (cheap via the `enabled` index), resolves each user, and dispatches a report
   * to those whose local time is due and whose local day is not yet sent. Swallows
   * its own top-level error so a DB hiccup never crashes the in-process scheduler.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async sweep(now: Date = new Date()): Promise<void> {
    try {
      const enabled =
        await this.userReportSettingsDatabaseService.findAllEnabled();

      if (enabled.length === 0) {
        return;
      }

      for (const settings of enabled) {
        await this.processUser(settings.userId, now);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';

      this.logger.warn(`Daily-report sweep failed: ${message}`);
    }
  }

  /**
   * Evaluates and, when due, dispatches the report for a single user. Re-reads the
   * settings row (so a concurrent PATCH or an earlier send in the same sweep is
   * honoured), computes the user's local `HH:mm` + date, and short-circuits unless
   * the local time matches `reportTimeLocal` and the local day is unsent. Marks the
   * day sent (persisted) BEFORE the interim direct-send for idempotency; only an
   * actually-delivered report keeps the mark. Per-user try/catch guarantees one
   * user's failure never aborts the rest of the sweep.
   */
  private async processUser(userId: string, now: Date): Promise<void> {
    try {
      const settings =
        await this.userReportSettingsDatabaseService.findByUserId(userId);

      if (!settings || !settings.enabled) {
        return;
      }

      const user = await this.userDatabaseService.findOneBy({ id: userId });

      if (!user) {
        return;
      }

      const localNow = DateTime.fromJSDate(now, { zone: user.timezone });
      const localTime = localNow.toFormat('HH:mm');
      const localDate = localNow.toISODate();

      if (!localDate) {
        // An invalid timezone yields an invalid DateTime — skip rather than throw.
        this.logger.warn(
          `User ${userId} has an unusable timezone "${user.timezone}" — skipping.`,
        );

        return;
      }

      if (localTime !== settings.reportTimeLocal) {
        return;
      }

      if (settings.lastSentLocalDate === localDate) {
        return;
      }

      const correlationId = `report-${userId}-${localDate}`;

      const report = await this.reportGeneratorService.generateForUser(
        user,
        localDate,
        correlationId,
      );

      if (!report) {
        // Empty generation — leave the day un-marked so a later minute can retry.
        return;
      }

      // Mark the day sent BEFORE the interim direct-send so a re-entrant sweep in
      // the same local minute cannot double-send. Persisted immediately.
      settings.lastSentLocalDate = localDate;

      await this.userReportSettingsDatabaseService.save(settings);

      const delivered = await this.reportSenderService.send(userId, report);

      if (!delivered) {
        // No link to deliver to: roll back the mark so a later link + minute can
        // still deliver. (A thrown vendor fault skips this and is caught below,
        // also leaving the mark — see ADR 0046 for the at-most-once posture.)
        settings.lastSentLocalDate = null;

        await this.userReportSettingsDatabaseService.save(settings);

        return;
      }

      this.logger.log(
        `[cid=${correlationId}] Sent daily report to user ${userId} for ${localDate}.`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';

      this.logger.warn(`Daily report for user ${userId} failed: ${message}`);
    }
  }
}
