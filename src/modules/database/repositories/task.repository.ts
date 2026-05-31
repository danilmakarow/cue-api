import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { Task } from '../entities';

import { BaseRepository } from './base.repository';

/**
 * Repository for the Task entity.
 */
@Injectable()
export class TaskRepository extends BaseRepository<Task> {
  constructor(dataSource: DataSource) {
    super(Task, dataSource.createEntityManager());
  }
}
