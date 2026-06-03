import { Module } from '@nestjs/common';

import { TaskOccurrenceExceptionService } from './task-occurrence-exception.service';
import { DatabaseModule } from '../database/database.module';

/**
 * TaskOccurrenceException module recording skip / override / completion overlays
 * for individual instances of a recurring task.
 */
@Module({
  imports: [DatabaseModule],
  providers: [TaskOccurrenceExceptionService],
  exports: [TaskOccurrenceExceptionService],
})
export class TaskOccurrenceExceptionModule {}
