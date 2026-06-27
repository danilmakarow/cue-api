import { Module } from '@nestjs/common';

import { DeviceController } from './device.controller';
import { DeviceService } from './device.service';
import { DatabaseModule } from '../database/database.module';

/**
 * Device module managing per-user APNs tokens for push delivery. Exposes the
 * S2 registration endpoints (`/users/me/devices`); push send is deferred (D1).
 */
@Module({
  imports: [DatabaseModule],
  controllers: [DeviceController],
  providers: [DeviceService],
  exports: [DeviceService],
})
export class DeviceModule {}
