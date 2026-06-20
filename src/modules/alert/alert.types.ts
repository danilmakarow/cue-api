/**
 * Provider-agnostic types for the alert sink (ADR 0007-style connector). The
 * alert sink is where the assistant escalates an operational event it cannot
 * recover from inside a turn — today the only such event is a narration
 * re-drive that exhausted its correction budget (ADR 0009). No vendor (Sentry,
 * a logger, etc.) shape crosses this boundary; the concrete connector maps a
 * normalized {@link AlertEvent} onto its own sink.
 */

/**
 * Supported alert sinks. `LOGGER` writes a structured log line (the default,
 * always available, no external dependency); `NOOP` swallows the event (local
 * dev, where an escalation alert would be noise). A future `SENTRY` would slot
 * in here behind the same contract without touching callers.
 */
export enum AlertProvider {
  LOGGER = 'logger',
  NOOP = 'noop',
}

/**
 * Severity of an alert event, mapped per-sink (a logger picks a log level, a
 * future Sentry sink picks an issue level). Kept minimal — the assistant only
 * raises warnings and errors.
 */
export enum AlertSeverity {
  WARNING = 'warning',
  ERROR = 'error',
}

/**
 * A normalized operational event handed to the alert sink. `name` is a stable,
 * greppable event key (e.g. `assistant.correction_exhausted`) so events can be
 * counted/aggregated regardless of sink; `context` carries only log-safe
 * metadata (counts, ids) — NEVER prompt, tool, or user message content.
 */
export interface AlertEvent {
  name: string;
  severity: AlertSeverity;
  message: string;
  context?: Record<string, string | number | boolean | null>;
}
