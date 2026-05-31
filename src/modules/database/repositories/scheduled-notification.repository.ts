import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { ScheduledNotification } from '../entities';

import { BaseRepository } from './base.repository';

/**
 * Repository for the ScheduledNotification entity.
 */
@Injectable()
export class ScheduledNotificationRepository extends BaseRepository<ScheduledNotification> {
  constructor(dataSource: DataSource) {
    super(ScheduledNotification, dataSource.createEntityManager());
  }
}
