import { Injectable } from '@nestjs/common';

import { Task } from '@/modules/database/entities';
import { TaskRepository } from '@/modules/database/repositories';
import { BaseDatabaseService } from '@/modules/database/services/base-database.service';

/**
 * Database service for the Task entity.
 * Soft-deletion is handled by TypeORM via the `@DeleteDateColumn` on Task.
 */
@Injectable()
export class TaskDatabaseService extends BaseDatabaseService<Task> {
  constructor(taskRepository: TaskRepository) {
    super(taskRepository);
  }
}
