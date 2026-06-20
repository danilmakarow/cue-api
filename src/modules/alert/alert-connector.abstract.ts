import { AlertEvent, AlertProvider } from './alert.types';

/**
 * Provider-agnostic alert-sink contract (ADR 0007 connector pattern). An
 * implementation maps a normalized {@link AlertEvent} onto its own sink (a
 * structured log line, a future Sentry capture, etc.).
 *
 * Boundary: `capture` MUST NOT throw and MUST NOT block the caller on a slow
 * sink — an escalation alert is best-effort observability, never something a
 * user-facing turn can fail on. Callers fire it and move on (the assistant runs
 * under a BullMQ `attempts:1` posture, so a throw out of the turn would lose the
 * turn). Implementations swallow their own transport errors.
 */
export abstract class AlertConnector {
  /** The sink this connector writes to. */
  abstract readonly provider: AlertProvider;

  /**
   * Records one operational event on the sink. Best-effort and non-throwing;
   * the return resolves once the event has been handed off (a log write is
   * synchronous, a network sink fires-and-forgets internally).
   */
  abstract capture(event: AlertEvent): void;
}
