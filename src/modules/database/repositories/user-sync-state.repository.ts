import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { UserSyncState } from '../entities';
import { BaseRepository } from './base.repository';

/**
 * Repository for the UserSyncState entity.
 */
@Injectable()
export class UserSyncStateRepository extends BaseRepository<UserSyncState> {
  constructor(dataSource: DataSource) {
    super(UserSyncState, dataSource.createEntityManager());
  }
}
