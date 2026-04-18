import { Injectable } from '@nestjs/common';

import { DeviceDatabaseService } from '@/modules/database/services';

/**
 * Service handling device registration and APNs token management.
 * Skeleton — device lifecycle endpoints land in later steps.
 */
@Injectable()
export class DeviceService {
  constructor(private readonly deviceDatabaseService: DeviceDatabaseService) {}
}
