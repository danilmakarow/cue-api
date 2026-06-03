import { Injectable } from '@nestjs/common';

import { ExternalVendorConnector } from './external-vendor-connector.abstract';
import { ExternalVendorConfig } from './external-vendor.config';
import { ExternalVendor } from './external-vendor.types';
import { TelegramVendorConnector } from './telegram/telegram-vendor.connector';

/**
 * Resolves the active {@link ExternalVendorConnector} from configuration and
 * provides lookup by vendor. Fails fast at startup when `EXTERNAL_VENDOR` is
 * missing, unknown, or has no registered connector.
 */
@Injectable()
export class ExternalVendorConnectorFactory {
  private readonly connectors: Map<ExternalVendor, ExternalVendorConnector>;

  private readonly activeVendor: ExternalVendor;

  constructor(
    config: ExternalVendorConfig,
    telegramConnector: TelegramVendorConnector,
  ) {
    this.connectors = new Map<ExternalVendor, ExternalVendorConnector>([
      [ExternalVendor.Telegram, telegramConnector],
    ]);
    this.activeVendor = this.resolveActiveVendor(config);
  }

  /**
   * Determines the active vendor from config, throwing when it is missing,
   * unrecognized, or has no registered connector so misconfiguration surfaces
   * at startup rather than on the first webhook.
   */
  private resolveActiveVendor(config: ExternalVendorConfig): ExternalVendor {
    const vendor = config.getActiveVendor();

    if (!vendor) {
      throw new Error(
        'EXTERNAL_VENDOR is not set to a supported vendor (expected one of: ' +
          `${Object.values(ExternalVendor).join(', ')})`,
      );
    }

    if (!this.connectors.has(vendor)) {
      throw new Error(`No connector registered for vendor "${vendor}"`);
    }

    return vendor;
  }

  /**
   * Returns the connector for the active vendor.
   */
  getActive(): ExternalVendorConnector {
    return this.get(this.activeVendor);
  }

  /**
   * Returns the connector for a specific vendor, throwing when none is
   * registered.
   */
  get(vendor: ExternalVendor): ExternalVendorConnector {
    const connector = this.connectors.get(vendor);

    if (!connector) {
      throw new Error(`No connector registered for vendor "${vendor}"`);
    }

    return connector;
  }
}
