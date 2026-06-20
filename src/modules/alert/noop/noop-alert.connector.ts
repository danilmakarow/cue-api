import { Injectable } from '@nestjs/common';

import { AlertConnector } from '../alert-connector.abstract';
import { AlertEvent, AlertProvider } from '../alert.types';

/**
 * No-op alert sink for local development, where an escalation alert is noise.
 * Swallows every event without side effects. Selected by default when
 * `NODE_ENV=development` (see {@link AlertConfig}).
 */
@Injectable()
export class NoopAlertConnector extends AlertConnector {
  readonly provider = AlertProvider.NOOP;

  /**
   * Discards the event. The parameter is intentionally unused — this sink
   * exists so the assistant can always depend on the {@link AlertConnector}
   * contract regardless of environment.
   */
  capture(_event: AlertEvent): void {
    // Intentionally empty: alerts are suppressed in local development.
  }
}
