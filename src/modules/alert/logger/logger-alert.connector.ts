import { Injectable, Logger } from '@nestjs/common';

import { AlertConnector } from '../alert-connector.abstract';
import { AlertEvent, AlertProvider, AlertSeverity } from '../alert.types';

/**
 * Default alert sink: writes one structured, greppable log line per event so an
 * escalation is observable in whatever log pipeline is configured (CloudWatch in
 * production), with no external dependency. The event `name` leads the line so a
 * log query can count occurrences (e.g. `assistant.correction_exhausted`).
 *
 * Maps {@link AlertSeverity} to the matching Nest log level. `capture` never
 * throws — formatting and logging are synchronous and side-effect-free beyond
 * the log write — so a caller on a user-facing turn can fire it safely.
 */
@Injectable()
export class LoggerAlertConnector extends AlertConnector {
  private readonly logger = new Logger(LoggerAlertConnector.name);

  readonly provider = AlertProvider.LOGGER;

  /**
   * Serializes the event's log-safe context map into a stable `key=value`
   * string for a single greppable log line. Returns an empty string when there
   * is no context.
   */
  private formatContext(context: AlertEvent['context'] | undefined): string {
    if (!context) {
      return '';
    }

    const parts = Object.entries(context).map(
      ([key, value]) => `${key}=${value ?? 'none'}`,
    );

    return parts.length > 0 ? ` ${parts.join(' ')}` : '';
  }

  /**
   * Writes the event as one structured log line at the level matching its
   * severity. Best-effort: a log-write failure is swallowed so the caller's turn
   * is never affected.
   */
  capture(event: AlertEvent): void {
    const line = `[alert] ${event.name}: ${event.message}${this.formatContext(
      event.context,
    )}`;

    try {
      if (event.severity === AlertSeverity.ERROR) {
        this.logger.error(line);

        return;
      }

      this.logger.warn(line);
    } catch {
      // Best-effort sink: never let an alert failure escape into the turn.
    }
  }
}
