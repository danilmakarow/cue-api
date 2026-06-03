import { Module } from '@nestjs/common';

import { TaskController } from './task.controller';
import { TaskService } from './task.service';
import { DatabaseModule } from '../database/database.module';
import { RecurrenceRuleModule } from '../recurrence-rule/recurrence-rule.module';
import { TaskOccurrenceExceptionModule } from '../task-occurrence-exception/task-occurrence-exception.module';

/**
 * Task module owning the unified event-plus-todo primitive. Imports the
 * recurrence engine and the occurrence-exception store so `TaskService` can
 * expand rules and write per-instance overrides; `TaskGroupDatabaseService`
 * (for group co-location checks) and the other DB services come from
 * `DatabaseModule`.
 */
@Module({
  imports: [
    DatabaseModule,
    RecurrenceRuleModule,
    TaskOccurrenceExceptionModule,
  ],
  controllers: [TaskController],
  providers: [TaskService],
  exports: [TaskService],
})
export class TaskModule {}
