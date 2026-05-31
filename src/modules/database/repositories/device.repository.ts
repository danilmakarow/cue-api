import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { Device } from '../entities';

import { BaseRepository } from './base.repository';

/**
 * Repository for the Device entity providing APNs-token-scoped query helpers.
 */
@Injectable()
export class DeviceRepository extends BaseRepository<Device> {
  constructor(dataSource: DataSource) {
    super(Device, dataSource.createEntityManager());
  }
}
