import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { RecurrenceRule } from '../entities';

import { BaseRepository } from './base.repository';

/**
 * Repository for the RecurrenceRule entity.
 */
@Injectable()
export class RecurrenceRuleRepository extends BaseRepository<RecurrenceRule> {
  constructor(dataSource: DataSource) {
    super(RecurrenceRule, dataSource.createEntityManager());
  }
}
