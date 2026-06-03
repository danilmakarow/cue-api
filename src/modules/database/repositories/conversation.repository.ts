import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { Conversation } from '../entities';
import { BaseRepository } from './base.repository';

/**
 * Repository for the Conversation entity.
 */
@Injectable()
export class ConversationRepository extends BaseRepository<Conversation> {
  constructor(dataSource: DataSource) {
    super(Conversation, dataSource.createEntityManager());
  }
}
