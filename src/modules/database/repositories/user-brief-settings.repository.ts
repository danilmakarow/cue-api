import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { UserBriefSettings } from '../entities';
import { BaseRepository } from './base.repository';

/**
 * Repository for the UserBriefSettings entity.
 */
@Injectable()
export class UserBriefSettingsRepository extends BaseRepository<UserBriefSettings> {
  constructor(dataSource: DataSource) {
    super(UserBriefSettings, dataSource.createEntityManager());
  }
}
