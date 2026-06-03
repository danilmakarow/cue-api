import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { ConversationMessage } from '../entities';
import { BaseRepository } from './base.repository';

/**
 * Repository for the ConversationMessage entity.
 */
@Injectable()
export class ConversationMessageRepository extends BaseRepository<ConversationMessage> {
  constructor(dataSource: DataSource) {
    super(ConversationMessage, dataSource.createEntityManager());
  }
}
