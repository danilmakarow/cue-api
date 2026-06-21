import { Inject, Injectable, Logger } from '@nestjs/common';

import { TelegramLinkDatabaseService } from '@/modules/database/services';
import { ExternalVendorConnector } from '@/modules/external-vendor/external-vendor-connector.abstract';
import { ACTIVE_VENDOR_CONNECTOR } from '@/modules/external-vendor/external-vendor.module';

/**
 * INTERIM direct-send path for the daily report (Story 17 / ADR 0046, Corrected
 * Assumption 3). The durable `ScheduledNotification` delivery worker does NOT yet
 * exist, so this resolves the user's linked Telegram chat and sends the generated
 * report STRAIGHT through the active vendor connector — bypassing the outbox. This
 * is a deliberate stopgap; the durable, retried, audited delivery worker is a
 * separate follow-up (see notification-delivery.md). When it lands, this sender
 * should enqueue a `ScheduledNotification` instead of calling the vendor directly.
 */
@Injectable()
export class ReportSenderService {
  private readonly logger = new Logger(ReportSenderService.name);

  constructor(
    @Inject(ACTIVE_VENDOR_CONNECTOR)
    private readonly vendor: ExternalVendorConnector,
    private readonly telegramLinkDatabaseService: TelegramLinkDatabaseService,
  ) {}

  /**
   * Sends the report text to the user's linked Telegram chat. Returns true when
   * delivery succeeded, false when the user has no link (nothing to send to) — the
   * caller treats false as "not delivered" and does NOT mark the day sent, so a
   * later link + minute can still deliver. A vendor send fault propagates to the
   * caller's per-user try/catch (so the day is not marked on a failed send).
   */
  async send(userId: string, report: string): Promise<boolean> {
    const link = await this.telegramLinkDatabaseService.findByUserId(userId);

    if (!link) {
      this.logger.warn(
        `Daily report for user ${userId} has no Telegram link — skipping send.`,
      );

      return false;
    }

    await this.vendor.sendMessage(
      { vendorChatId: link.telegramChatId },
      { text: report },
    );

    return true;
  }
}
