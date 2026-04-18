import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { NotificationStrategy } from '../entities';
import { BaseRepository } from './base.repository';

/**
 * Repository for the NotificationStrategy entity.
 */
@Injectable()
export class NotificationStrategyRepository extends BaseRepository<NotificationStrategy> {
  constructor(dataSource: DataSource) {
    super(NotificationStrategy, dataSource.createEntityManager());
  }
}
