import { Injectable } from '@nestjs/common';

import { Device } from '@/modules/database/entities';
import { DeviceRepository } from '@/modules/database/repositories';
import { BaseDatabaseService } from '@/modules/database/services/base-database.service';

/**
 * Database service for the Device entity.
 */
@Injectable()
export class DeviceDatabaseService extends BaseDatabaseService<Device> {
  constructor(deviceRepository: DeviceRepository) {
    super(deviceRepository);
  }

  /**
   * Finds a device by its APNs token. Returns null when none exists.
   */
  findByApnsToken(apnsToken: string) {
    return this.findOneBy({ apnsToken });
  }
}
