import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { Calendar } from '../entities';
import { BaseRepository } from './base.repository';

/**
 * Repository for the Calendar entity.
 */
@Injectable()
export class CalendarRepository extends BaseRepository<Calendar> {
  constructor(dataSource: DataSource) {
    super(Calendar, dataSource.createEntityManager());
  }
}
