import { Injectable } from '@nestjs/common';

import { UserSyncState } from '@/modules/database/entities';
import { UserSyncStateRepository } from '@/modules/database/repositories';
import { BaseDatabaseService } from '@/modules/database/services/base-database.service';

/**
 * Database service for the UserSyncState entity — the per-user sync revision.
 */
@Injectable()
export class UserSyncStateDatabaseService extends BaseDatabaseService<UserSyncState> {
  private readonly userSyncStateRepository: UserSyncStateRepository;

  constructor(userSyncStateRepository: UserSyncStateRepository) {
    super(userSyncStateRepository);
    this.userSyncStateRepository = userSyncStateRepository;
  }

  /**
   * Atomically increments the user's sync revision, creating the row on first
   * write. A single `INSERT ... ON CONFLICT DO UPDATE` — no read-modify-write
   * race, no lost update. Runs on the ambient transaction's query runner (the
   * transactional manager is resolved via the patched `Repository.manager`
   * getter), so the bump commits atomically with the data change that triggered
   * it.
   */
  async bump(userId: string): Promise<void> {
    await this.userSyncStateRepository.query(
      `INSERT INTO user_sync_state ("userId", revision, "changedAt")
       VALUES ($1, 1, now())
       ON CONFLICT ("userId") DO UPDATE
         SET revision = user_sync_state.revision + 1,
             "changedAt" = now(),
             "updatedAt" = now()`,
      [userId],
    );
  }

  /**
   * Returns the user's sync-state row, or null when they have never had a
   * mutation bump one into existence.
   */
  async getByUserId(userId: string): Promise<UserSyncState | null> {
    return this.findOneBy({ userId });
  }
}
