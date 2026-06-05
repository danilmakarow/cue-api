import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ExternalVendor } from './external-vendor.types';

/** Default Telegram Bot API base; overridable via `TELEGRAM_API_BASE` for tests. */
const DEFAULT_TELEGRAM_API_BASE = 'https://api.telegram.org';

/**
 * Resolved Telegram connector configuration.
 */
export interface TelegramVendorConfig {
  /** Bot token used to build `/bot<token>/...` API URLs. */
  botToken: string;
  /** Shared secret verified against the `X-Telegram-Bot-Api-Secret-Token` header. */
  webhookSecret: string;
  /** Telegram Bot API base URL (no trailing slash). */
  apiBase: string;
}

/**
 * Typed accessor for external-vendor configuration. Reads keys via the injected
 * `ConfigService` (never `process.env`); the global Zod env schema is owned by
 * the wiring task and is not modified here.
 *
 * Env keys read: `EXTERNAL_VENDOR`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`,
 * optional `TELEGRAM_API_BASE`.
 */
@Injectable()
export class ExternalVendorConfig {
  constructor(private readonly configService: ConfigService) {}

  /**
   * Returns the active vendor selected via `EXTERNAL_VENDOR`, or `undefined`
   * when the value is missing or not a recognized vendor. The factory decides
   * how to fail on an unknown/missing value.
   */
  getActiveVendor(): ExternalVendor | undefined {
    const raw = this.configService.get<string>('EXTERNAL_VENDOR');

    if (!raw) {
      return undefined;
    }

    const known = Object.values(ExternalVendor).find(
      (vendor) => (vendor as string) === raw,
    );

    return known;
  }

  /**
   * Returns the resolved Telegram config, throwing when a required key is
   * missing so misconfiguration fails fast at startup.
   */
  getTelegramConfig(): TelegramVendorConfig {
    const botToken = this.configService.get<string>('TELEGRAM_BOT_TOKEN');

    if (!botToken) {
      throw new Error('TELEGRAM_BOT_TOKEN is not configured');
    }

    const webhookSecret = this.configService.get<string>(
      'TELEGRAM_WEBHOOK_SECRET',
    );

    if (!webhookSecret) {
      throw new Error('TELEGRAM_WEBHOOK_SECRET is not configured');
    }

    const apiBase =
      this.configService.get<string>('TELEGRAM_API_BASE') ??
      DEFAULT_TELEGRAM_API_BASE;

    return {
      botToken,
      webhookSecret,
      apiBase: this.stripTrailingSlash(apiBase),
    };
  }

  /**
   * Removes a single trailing slash so callers can safely concatenate paths.
   */
  private stripTrailingSlash(value: string): string {
    if (!value.endsWith('/')) {
      return value;
    }

    return value.slice(0, -1);
  }
}
