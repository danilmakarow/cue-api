import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { ExternalVendorConnectorFactory } from './external-vendor-connector.factory';
import { ExternalVendorConfig } from './external-vendor.config';
import { TelegramVendorConnector } from './telegram/telegram-vendor.connector';

/**
 * Injection token for the active {@link ExternalVendorConnector}, resolved from
 * `EXTERNAL_VENDOR`. Inject this when you just need "the current vendor" without
 * going through the factory.
 */
export const ACTIVE_VENDOR_CONNECTOR = Symbol('ACTIVE_VENDOR_CONNECTOR');

/**
 * Wires the external-vendor connectors, their typed config, the resolving
 * factory, and the `ACTIVE_VENDOR_CONNECTOR` binding. This is the only module
 * that knows vendor-specific wire formats.
 */
@Module({
  imports: [ConfigModule],
  providers: [
    ExternalVendorConfig,
    TelegramVendorConnector,
    ExternalVendorConnectorFactory,
    {
      provide: ACTIVE_VENDOR_CONNECTOR,
      useFactory: (factory: ExternalVendorConnectorFactory) =>
        factory.getActive(),
      inject: [ExternalVendorConnectorFactory],
    },
  ],
  exports: [ExternalVendorConnectorFactory, ACTIVE_VENDOR_CONNECTOR],
})
export class ExternalVendorModule {}
