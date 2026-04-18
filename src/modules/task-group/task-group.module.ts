import { Module } from '@nestjs/common';

import { TaskGroupService } from './task-group.service';
import { DatabaseModule } from '../database/database.module';

/**
 * TaskGroup module managing user-owned task buckets.
 */
@Module({
  imports: [DatabaseModule],
  providers: [TaskGroupService],
  exports: [TaskGroupService],
})
export class TaskGroupModule {}
