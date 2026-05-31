import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';

import { TaskController } from './task.controller';
import { TaskService } from './task.service';

/**
 * Task module owning the unified event-plus-todo primitive.
 */
@Module({
  imports: [DatabaseModule],
  controllers: [TaskController],
  providers: [TaskService],
  exports: [TaskService],
})
export class TaskModule {}
