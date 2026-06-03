import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { AssistantConfig } from './assistant.config';
import { ExternalVendorConnectorFactory } from '@/modules/external-vendor/external-vendor-connector.factory';

/** Path the vendor webhook is registered against (mounted by the controller). */
const WEBHOOK_PATH = '/assistant/telegram/webhook';

/**
 * Registers the inbound webhook with the active vendor on boot, guarded by
 * `ASSISTANT_WEBHOOK_URL`: when the public URL is unset (local dev uses the
 * ngrok script to register manually) registration is skipped, and any failure
 * is logged rather than crashing startup.
 */
@Injectable()
export class WebhookRegistrarService implements OnModuleInit {
  private readonly logger = new Logger(WebhookRegistrarService.name);

  constructor(
    private readonly vendorFactory: ExternalVendorConnectorFactory,
    private readonly config: AssistantConfig,
  ) {}

  /**
   * On startup, registers the webhook URL with the vendor when a public base is
   * configured; otherwise logs that registration was skipped.
   */
  async onModuleInit(): Promise<void> {
    const baseUrl = this.config.webhookUrl;

    if (!baseUrl) {
      this.logger.log(
        'ASSISTANT_WEBHOOK_URL not set — skipping vendor webhook registration.',
      );

      return;
    }

    const url = `${baseUrl.replace(/\/$/, '')}${WEBHOOK_PATH}`;

    try {
      await this.vendorFactory.getActive().registerWebhook(url);

      this.logger.log(`Registered vendor webhook at ${url}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';

      this.logger.error(`Failed to register vendor webhook: ${message}`);
    }
  }
}
