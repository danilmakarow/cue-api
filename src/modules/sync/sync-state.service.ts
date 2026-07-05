import { Injectable } from '@nestjs/common';

import { SyncStateDto } from './dtos';
import { UserSyncStateDatabaseService } from '@/modules/database/services';

/**
 * Owns the per-user sync revision. Feature services call {@link bump} as the
 * last statement inside their mutation transactions so the revision advances
 * atomically with the data change; the client polls {@link getState} to decide
 * whether a full delta pull is needed.
 */
@Injectable()
export class SyncStateService {
  constructor(
    private readonly userSyncStateDatabaseService: UserSyncStateDatabaseService,
  ) {}

  /**
   * Atomically increments the user's sync revision. Safe to call more than once
   * per request — the revision is an equality token, never a count.
   */
  async bump(userId: string): Promise<void> {
    await this.userSyncStateDatabaseService.bump(userId);
  }

  /**
   * Returns the cheap sync-state snapshot. When the user has no row yet (no
   * mutation has ever bumped one into existence) reports revision `"0"` with a
   * null `changedAt` — the client treats the first `nil → "0"` transition as a
   * single change and runs one delta to settle.
   */
  async getState(userId: string): Promise<SyncStateDto> {
    const serverTime = new Date().toISOString();
    const state = await this.userSyncStateDatabaseService.getByUserId(userId);

    if (!state) {
      return { revision: '0', changedAt: null, serverTime };
    }

    return {
      revision: state.revision,
      changedAt: state.changedAt.toISOString(),
      serverTime,
    };
  }
}
