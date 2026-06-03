import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';

import { ExternalVendorConnector } from './external-vendor-connector.abstract';
import { ExternalVendorConnectorFactory } from './external-vendor-connector.factory';
import {
  ACTIVE_VENDOR_CONNECTOR,
  ExternalVendorModule,
} from './external-vendor.module';
import { ExternalVendor } from './external-vendor.types';
import { TelegramVendorConnector } from './telegram/telegram-vendor.connector';

/**
 * Builds a `ConfigService` stub backed by a plain key/value map for DI tests.
 */
const configServiceFor = (
  values: Record<string, string>,
): Partial<ConfigService> => ({
  get: <T>(key: string): T | undefined => values[key] as unknown as T,
});

describe('ExternalVendorModule (integration)', () => {
  it('binds ACTIVE_VENDOR_CONNECTOR to the Telegram connector when EXTERNAL_VENDOR=telegram', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ExternalVendorModule],
    })
      .overrideProvider(ConfigService)
      .useValue(
        configServiceFor({
          EXTERNAL_VENDOR: 'telegram',
          TELEGRAM_BOT_TOKEN: 'token',
          TELEGRAM_WEBHOOK_SECRET: 'secret',
        }),
      )
      .compile();

    const active = moduleRef.get<ExternalVendorConnector>(
      ACTIVE_VENDOR_CONNECTOR,
    );
    const factory = moduleRef.get(ExternalVendorConnectorFactory);

    expect(active).toBeInstanceOf(TelegramVendorConnector);
    expect(active.vendor).toBe(ExternalVendor.Telegram);
    expect(factory.getActive()).toBe(active);
    expect(factory.get(ExternalVendor.Telegram)).toBe(active);

    await moduleRef.close();
  });

  it('fails fast when EXTERNAL_VENDOR is unknown', async () => {
    await expect(
      Test.createTestingModule({ imports: [ExternalVendorModule] })
        .overrideProvider(ConfigService)
        .useValue(
          configServiceFor({
            EXTERNAL_VENDOR: 'whatsapp',
            TELEGRAM_BOT_TOKEN: 'token',
            TELEGRAM_WEBHOOK_SECRET: 'secret',
          }),
        )
        .compile(),
    ).rejects.toThrow(/EXTERNAL_VENDOR/);
  });

  it('fails fast when a required Telegram key is missing', async () => {
    await expect(
      Test.createTestingModule({ imports: [ExternalVendorModule] })
        .overrideProvider(ConfigService)
        .useValue(configServiceFor({ EXTERNAL_VENDOR: 'telegram' }))
        .compile(),
    ).rejects.toThrow(/TELEGRAM_BOT_TOKEN/);
  });
});
