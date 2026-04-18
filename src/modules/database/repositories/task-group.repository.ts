import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { TaskGroup } from '../entities';
import { BaseRepository } from './base.repository';

/**
 * Repository for the TaskGroup entity.
 */
@Injectable()
export class TaskGroupRepository extends BaseRepository<TaskGroup> {
  constructor(dataSource: DataSource) {
    super(TaskGroup, dataSource.createEntityManager());
  }
}
