import { Module } from '@nestjs/common';

import { DailyReportScheduler } from './daily-report.scheduler';
import { ReportGeneratorService } from './report-generator.service';
import { ReportSenderService } from './report-sender.service';
import { ReportSettingsController } from './report-settings.controller';
import { ReportSettingsService } from './report-settings.service';
import { AiModule } from '@/modules/ai/ai.module';
import { DatabaseModule } from '@/modules/database/database.module';
import { ExternalVendorModule } from '@/modules/external-vendor/external-vendor.module';
import { TaskModule } from '@/modules/task/task.module';

/**
 * Report module (Story 17 / ADR 0046) — the per-day notification report. Wires:
 * - the REST settings surface (`GET`/`PATCH /users/me/report-settings`) behind
 *   `AccessTokenGuard`, provided by the `@Global()` `AuthModule` (so it is applied
 *   without importing that module, mirroring the other feature controllers);
 * - the per-minute `@nestjs/schedule` scheduler that scans opted-in users and
 *   dispatches a report when their local time is due (idempotent per local date);
 * - the one-shot report generator (MAIN model via `AiModule`, agenda via
 *   `TaskModule`) and the INTERIM direct-send sender (vendor connector via
 *   `ExternalVendorModule`). The durable `ScheduledNotification` delivery worker
 *   is a separate follow-up (Corrected Assumption 3).
 */
@Module({
  imports: [DatabaseModule, AiModule, TaskModule, ExternalVendorModule],
  controllers: [ReportSettingsController],
  providers: [
    ReportSettingsService,
    ReportGeneratorService,
    ReportSenderService,
    DailyReportScheduler,
  ],
  exports: [ReportSettingsService],
})
export class ReportModule {}
