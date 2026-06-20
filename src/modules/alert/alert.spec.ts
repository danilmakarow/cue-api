import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AlertConnectorFactory } from './alert-connector.factory';
import { AlertConfig } from './alert.config';
import { AlertProvider, AlertSeverity } from './alert.types';
import { LoggerAlertConnector } from './logger/logger-alert.connector';
import { NoopAlertConnector } from './noop/noop-alert.connector';

/**
 * Builds an {@link AlertConfig} over a stub `ConfigService` returning the given
 * env map, so provider resolution is testable without a real config tree.
 */
const buildConfig = (env: Record<string, string | undefined>): AlertConfig =>
  new AlertConfig({
    get: (key: string) => env[key],
  } as unknown as ConfigService);

describe('AlertConfig', () => {
  it('defaults to the no-op sink in development', () => {
    expect(buildConfig({ NODE_ENV: 'development' }).getProvider()).toBe(
      AlertProvider.NOOP,
    );
  });

  it('defaults to the logger sink in production', () => {
    expect(buildConfig({ NODE_ENV: 'production' }).getProvider()).toBe(
      AlertProvider.LOGGER,
    );
  });

  it('honors an explicit ASSISTANT_ALERT_PROVIDER override', () => {
    expect(
      buildConfig({
        NODE_ENV: 'development',
        ASSISTANT_ALERT_PROVIDER: 'logger',
      }).getProvider(),
    ).toBe(AlertProvider.LOGGER);
  });

  it('throws fast on an unrecognized provider override', () => {
    expect(() =>
      buildConfig({ ASSISTANT_ALERT_PROVIDER: 'pagerduty' }),
    ).toThrow(/unknown ASSISTANT_ALERT_PROVIDER/);
  });
});

describe('LoggerAlertConnector', () => {
  it('writes an error-level structured line with the event name and context', () => {
    const errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const connector = new LoggerAlertConnector();

    connector.capture({
      name: 'assistant.correction_exhausted',
      severity: AlertSeverity.ERROR,
      message: 'budget spent',
      context: { corrections: 5, userId: 'user-1' },
    });

    expect(errorSpy).toHaveBeenCalledTimes(1);

    const line = errorSpy.mock.calls[0][0] as string;

    expect(line).toContain('assistant.correction_exhausted');
    expect(line).toContain('budget spent');
    expect(line).toContain('corrections=5');
    expect(line).toContain('userId=user-1');

    errorSpy.mockRestore();
  });

  it('writes a warn-level line for warning severity', () => {
    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const connector = new LoggerAlertConnector();

    connector.capture({
      name: 'assistant.something',
      severity: AlertSeverity.WARNING,
      message: 'heads up',
    });

    expect(warnSpy).toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
  });

  it('never throws even if the underlying logger throws', () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {
      throw new Error('log pipe down');
    });

    const connector = new LoggerAlertConnector();

    expect(() =>
      connector.capture({
        name: 'x',
        severity: AlertSeverity.ERROR,
        message: 'y',
      }),
    ).not.toThrow();

    jest.restoreAllMocks();
  });
});

describe('NoopAlertConnector', () => {
  it('swallows the event without logging', () => {
    const errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const connector = new NoopAlertConnector();

    connector.capture({
      name: 'x',
      severity: AlertSeverity.ERROR,
      message: 'y',
    });

    expect(errorSpy).not.toHaveBeenCalled();

    errorSpy.mockRestore();
  });
});

describe('AlertConnectorFactory', () => {
  const logger = new LoggerAlertConnector();
  const noop = new NoopAlertConnector();

  it('resolves the configured active connector', () => {
    const factory = new AlertConnectorFactory(
      buildConfig({ NODE_ENV: 'production' }),
      logger,
      noop,
    );

    expect(factory.getActive()).toBe(logger);
  });

  it('resolves a connector by provider', () => {
    const factory = new AlertConnectorFactory(
      buildConfig({ NODE_ENV: 'development' }),
      logger,
      noop,
    );

    expect(factory.get(AlertProvider.NOOP)).toBe(noop);
    expect(factory.getActive()).toBe(noop);
  });
});
