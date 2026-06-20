import { Injectable } from '@nestjs/common';

import { AlertConnector } from './alert-connector.abstract';
import { AlertConfig } from './alert.config';
import { AlertProvider } from './alert.types';
import { LoggerAlertConnector } from './logger/logger-alert.connector';
import { NoopAlertConnector } from './noop/noop-alert.connector';

/**
 * Resolves the active {@link AlertConnector} from config (ADR 0007). Holds a
 * registry of all implementations keyed by provider; `getActive()` returns the
 * one selected by {@link AlertConfig}, while `get(provider)` keeps a future
 * multi-sink world available. An unregistered provider fails fast at startup.
 */
@Injectable()
export class AlertConnectorFactory {
  private readonly connectors: Map<AlertProvider, AlertConnector>;

  constructor(
    private readonly config: AlertConfig,
    loggerConnector: LoggerAlertConnector,
    noopConnector: NoopAlertConnector,
  ) {
    this.connectors = new Map<AlertProvider, AlertConnector>([
      [AlertProvider.LOGGER, loggerConnector],
      [AlertProvider.NOOP, noopConnector],
    ]);
  }

  /**
   * Returns the connector for a specific provider, throwing when no
   * implementation is registered for it.
   */
  get(provider: AlertProvider): AlertConnector {
    const connector = this.connectors.get(provider);

    if (!connector) {
      throw new Error(
        `No alert connector registered for provider "${provider}"`,
      );
    }

    return connector;
  }

  /**
   * Returns the connector for the configured active provider. Throws when that
   * provider has no registered implementation — surfaced at startup via the
   * `ACTIVE_ALERT_CONNECTOR` factory provider, not at the first escalation.
   */
  getActive(): AlertConnector {
    return this.get(this.config.getProvider());
  }
}
