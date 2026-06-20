import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AlertConnector } from './alert-connector.abstract';
import { AlertConnectorFactory } from './alert-connector.factory';
import { AlertConfig } from './alert.config';
import { LoggerAlertConnector } from './logger/logger-alert.connector';
import { NoopAlertConnector } from './noop/noop-alert.connector';

/**
 * Injection token resolving to the active {@link AlertConnector} (the one
 * selected by {@link AlertConfig}). Consumers inject this to depend only on the
 * abstract contract; resolution happens once at startup, failing fast on a
 * misconfigured sink.
 */
export const ACTIVE_ALERT_CONNECTOR = Symbol('ACTIVE_ALERT_CONNECTOR');

/**
 * Alert sink module (ADR 0007 connector pattern). Registers the typed config,
 * the concrete sinks (structured logger + dev no-op), and the resolving factory;
 * exports the factory and the `ACTIVE_ALERT_CONNECTOR` token for the assistant
 * orchestrator to escalate unrecoverable turn events (ADR 0009). A Sentry sink
 * is a TODO stub (no dependency) — see `sentry/sentry-alert.connector.ts`.
 */
@Module({
  imports: [ConfigModule],
  providers: [
    AlertConfig,
    LoggerAlertConnector,
    NoopAlertConnector,
    AlertConnectorFactory,
    {
      provide: ACTIVE_ALERT_CONNECTOR,
      inject: [AlertConnectorFactory],
      useFactory: (factory: AlertConnectorFactory): AlertConnector =>
        factory.getActive(),
    },
  ],
  exports: [AlertConnectorFactory, ACTIVE_ALERT_CONNECTOR],
})
export class AlertModule {}
