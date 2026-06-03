import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { NotificationRule } from '../entities';
import { BaseRepository } from './base.repository';

/**
 * Repository for the NotificationRule entity.
 */
@Injectable()
export class NotificationRuleRepository extends BaseRepository<NotificationRule> {
  constructor(dataSource: DataSource) {
    super(NotificationRule, dataSource.createEntityManager());
  }
}
