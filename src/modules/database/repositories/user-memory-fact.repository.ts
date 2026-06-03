import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { UserMemoryFact } from '../entities';
import { BaseRepository } from './base.repository';

/**
 * Repository for the UserMemoryFact entity.
 */
@Injectable()
export class UserMemoryFactRepository extends BaseRepository<UserMemoryFact> {
  constructor(dataSource: DataSource) {
    super(UserMemoryFact, dataSource.createEntityManager());
  }
}
