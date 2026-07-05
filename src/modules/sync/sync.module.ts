import { Module } from '@nestjs/common';

import { SyncController } from './sync.controller';
import { SyncStateService } from './sync-state.service';
import { DatabaseModule } from '../database/database.module';

/**
 * Sync module — owns the per-user revision counter behind `GET /sync/state` and
 * exports {@link SyncStateService} so the task / task-group / calendar feature
 * services can bump the revision inside their mutation transactions.
 */
@Module({
  imports: [DatabaseModule],
  controllers: [SyncController],
  providers: [SyncStateService],
  exports: [SyncStateService],
})
export class SyncModule {}
