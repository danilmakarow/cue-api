import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { TelegramLink } from '../entities';
import { BaseRepository } from './base.repository';

/**
 * Repository for the TelegramLink entity.
 */
@Injectable()
export class TelegramLinkRepository extends BaseRepository<TelegramLink> {
  constructor(dataSource: DataSource) {
    super(TelegramLink, dataSource.createEntityManager());
  }
}
