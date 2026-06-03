import { Injectable } from '@nestjs/common';

import { UserMemoryFact } from '@/modules/database/entities';
import { UserMemoryFactRepository } from '@/modules/database/repositories';
import { BaseDatabaseService } from '@/modules/database/services/base-database.service';

/**
 * Database service for the UserMemoryFact entity.
 */
@Injectable()
export class UserMemoryFactDatabaseService extends BaseDatabaseService<UserMemoryFact> {
  constructor(userMemoryFactRepository: UserMemoryFactRepository) {
    super(userMemoryFactRepository);
  }

  /**
   * Returns every durable fact for a user, newest-first — the candidate set the
   * context builder filters down to the relevant subset for prompt block 3.
   */
  findAllByUserId(userId: string): Promise<UserMemoryFact[]> {
    return this.findAll({
      where: { userId },
      order: { updatedAt: 'DESC' },
    });
  }

  /**
   * Finds an existing fact by its natural key (userId + type + key), so the
   * background extractor can update it in place instead of duplicating. Returns
   * null when no matching fact exists.
   */
  findByNaturalKey(
    userId: string,
    type: UserMemoryFact['type'],
    key: string,
  ): Promise<UserMemoryFact | null> {
    return this.findOneBy({ userId, type, key });
  }
}
