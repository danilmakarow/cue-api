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
  private readonly taskRepository: TaskRepository;

  constructor(taskRepository: TaskRepository) {
    super(taskRepository);
    this.taskRepository = taskRepository;
  }

  /**
   * Bumps the parent Task's `updatedAt` to the current server time via a
   * targeted row-level UPDATE (no full entity load). Used by the exception
   * write path so per-occurrence override changes surface in the delta
   * endpoint's `Task.updatedAt > since` query. No-op for a missing id.
   */
  async touchUpdatedAt(taskId: string): Promise<void> {
    await this.taskRepository.update(taskId, { updatedAt: new Date() });
  }
}
