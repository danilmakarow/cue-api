import { Module } from '@nestjs/common';

import { TaskGroupController } from './task-group.controller';
import { TaskGroupService } from './task-group.service';
import { DatabaseModule } from '../database/database.module';

/**
 * TaskGroup module managing user-owned task buckets. Recurrence is stored inline
 * on the group row (ADR 0054); the service uses the static
 * `RecurrenceRuleService.toConfig` mapper, so no RecurrenceRuleModule import.
 */
@Module({
  imports: [DatabaseModule],
  controllers: [TaskGroupController],
  providers: [TaskGroupService],
  exports: [TaskGroupService],
})
export class TaskGroupModule {}
