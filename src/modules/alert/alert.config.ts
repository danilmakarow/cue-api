import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AlertProvider } from './alert.types';

/**
 * Typed configuration for the alert sink (ADR 0007). Resolves the active
 * provider from env once at construction, failing fast on an unrecognized
 * value. There is no dedicated env key today: the sink is selected by
 * environment — `NODE_ENV=development` defaults to the no-op (an escalation
 * alert is local noise), everything else to the structured logger. An optional
 * `ASSISTANT_ALERT_PROVIDER` override is honored if present so ops can force a
 * sink without a code change, but it is NOT a required env var (no Zod entry) —
 * the default-by-environment keeps the schema lean per the repo convention.
 */
@Injectable()
export class AlertConfig {
  private readonly provider: AlertProvider;

  constructor(private readonly configService: ConfigService) {
    this.provider = this.resolveProvider();
  }

  /**
   * Resolves the active alert provider: an explicit `ASSISTANT_ALERT_PROVIDER`
   * env value wins (throwing on an unrecognized one so a typo fails fast),
   * otherwise it defaults to the no-op sink in development and the structured
   * logger everywhere else.
   */
  private resolveProvider(): AlertProvider {
    const raw = this.configService.get<string>('ASSISTANT_ALERT_PROVIDER');

    if (raw === undefined || raw === null || raw === '') {
      const nodeEnv = this.configService.get<string>('NODE_ENV');

      return nodeEnv === 'development'
        ? AlertProvider.NOOP
        : AlertProvider.LOGGER;
    }

    const supportedProviders: string[] = Object.values(AlertProvider);

    if (!supportedProviders.includes(raw)) {
      throw new Error(
        `Alert sink misconfigured: unknown ASSISTANT_ALERT_PROVIDER "${raw}"`,
      );
    }

    return raw as AlertProvider;
  }

  /**
   * The configured active alert provider.
   */
  getProvider(): AlertProvider {
    return this.provider;
  }
}
