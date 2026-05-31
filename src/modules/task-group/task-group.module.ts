import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';

import { TaskGroupService } from './task-group.service';

/**
 * TaskGroup module managing user-owned task buckets.
 */
@Module({
  imports: [DatabaseModule],
  providers: [TaskGroupService],
  exports: [TaskGroupService],
})
export class TaskGroupModule {}
