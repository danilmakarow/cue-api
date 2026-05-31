import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { TaskOccurrenceException } from '../entities';

import { BaseRepository } from './base.repository';

/**
 * Repository for the TaskOccurrenceException entity.
 */
@Injectable()
export class TaskOccurrenceExceptionRepository extends BaseRepository<TaskOccurrenceException> {
  constructor(dataSource: DataSource) {
    super(TaskOccurrenceException, dataSource.createEntityManager());
  }
}
