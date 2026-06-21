import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { PersonaPrompt } from '../entities';
import { BaseRepository } from './base.repository';

/**
 * Repository for the PersonaPrompt entity.
 */
@Injectable()
export class PersonaPromptRepository extends BaseRepository<PersonaPrompt> {
  constructor(dataSource: DataSource) {
    super(PersonaPrompt, dataSource.createEntityManager());
  }
}
