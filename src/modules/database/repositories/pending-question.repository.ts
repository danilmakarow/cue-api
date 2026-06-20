import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { PendingQuestion } from '../entities';
import { BaseRepository } from './base.repository';

/**
 * Repository for the PendingQuestion entity.
 */
@Injectable()
export class PendingQuestionRepository extends BaseRepository<PendingQuestion> {
  constructor(dataSource: DataSource) {
    super(PendingQuestion, dataSource.createEntityManager());
  }
}
