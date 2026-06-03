import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { ConversationSummary } from '../entities';
import { BaseRepository } from './base.repository';

/**
 * Repository for the ConversationSummary entity.
 */
@Injectable()
export class ConversationSummaryRepository extends BaseRepository<ConversationSummary> {
  constructor(dataSource: DataSource) {
    super(ConversationSummary, dataSource.createEntityManager());
  }
}
