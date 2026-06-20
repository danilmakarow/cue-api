import { AlertConnector } from '../alert-connector.abstract';
import { AlertEvent, AlertProvider } from '../alert.types';

/**
 * TODO(sentry): Sentry is NOT wired in this repo and there is intentionally NO
 * `@sentry/*` dependency (ADR 0009: "Sentry is not wired… do not add a Sentry
 * dependency"). This file is a marked placeholder documenting where a Sentry
 * sink would live once the dependency and DSN env are introduced.
 *
 * To activate later:
 *  1. add `@sentry/node` (a deliberate new dependency — surface it first),
 *  2. add `SENTRY` to {@link AlertProvider} and register this connector in
 *     `AlertConnectorFactory`,
 *  3. add the DSN env var to the Zod schema + `.env.example` + ssm.tf,
 *  4. replace the body below with `Sentry.captureMessage(event.message, …)`,
 *     mapping {@link AlertEvent.severity} to a Sentry level and `event.context`
 *     to tags/extra (log-safe metadata only).
 *
 * It is deliberately NOT `@Injectable()`, NOT exported from the module, and NOT
 * a member of {@link AlertProvider}, so it cannot be selected or constructed —
 * it is a design note in code form, not a live sink.
 */
export class SentryAlertConnector extends AlertConnector {
  // Reuses the LOGGER provider id only to satisfy the abstract contract's type;
  // this class is never registered, so the id is never resolved against it.
  readonly provider = AlertProvider.LOGGER;

  /**
   * Placeholder — throws if ever called, to make an accidental wiring loud
   * rather than silently dropping escalations.
   */
  capture(_event: AlertEvent): void {
    throw new Error(
      'SentryAlertConnector is a TODO stub: Sentry is not wired (no dependency). ' +
        'Use LoggerAlertConnector until Sentry is introduced.',
    );
  }
}
