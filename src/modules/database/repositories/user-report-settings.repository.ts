import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { UserReportSettings } from '../entities';
import { BaseRepository } from './base.repository';

/**
 * Repository for the UserReportSettings entity.
 */
@Injectable()
export class UserReportSettingsRepository extends BaseRepository<UserReportSettings> {
  constructor(dataSource: DataSource) {
    super(UserReportSettings, dataSource.createEntityManager());
  }
}
