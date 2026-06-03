import { Module } from '@nestjs/common';

import { TaskGroupController } from './task-group.controller';
import { TaskGroupService } from './task-group.service';
import { DatabaseModule } from '../database/database.module';
import { RecurrenceRuleModule } from '../recurrence-rule/recurrence-rule.module';

/**
 * TaskGroup module managing user-owned task buckets.
 */
@Module({
  imports: [DatabaseModule, RecurrenceRuleModule],
  controllers: [TaskGroupController],
  providers: [TaskGroupService],
  exports: [TaskGroupService],
})
export class TaskGroupModule {}
