import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';

import { DeviceService } from './device.service';

/**
 * Device module managing per-user APNs tokens for push delivery.
 */
@Module({
  imports: [DatabaseModule],
  providers: [DeviceService],
  exports: [DeviceService],
})
export class DeviceModule {}
