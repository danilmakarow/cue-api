import { Module } from '@nestjs/common';

import { DeviceService } from './device.service';
import { DatabaseModule } from '../database/database.module';

/**
 * Device module managing per-user APNs tokens for push delivery.
 */
@Module({
  imports: [DatabaseModule],
  providers: [DeviceService],
  exports: [DeviceService],
})
export class DeviceModule {}
