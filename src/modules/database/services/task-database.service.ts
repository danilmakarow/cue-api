import { Injectable } from '@nestjs/common';
import { In } from 'typeorm';

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

  /**
   * Bumps `updatedAt` on every task in a group via one targeted UPDATE. Used when
   * a group's effective settings (color / recurrence / requiresCompletion) change
   * so the member tasks — whose own rows are untouched — still surface in the
   * delta endpoint's `Task.updatedAt > since` query.
   */
  async touchAllInGroup(groupId: string): Promise<void> {
    await this.taskRepository.update({ groupId }, { updatedAt: new Date() });
  }

  /**
   * Returns the ids of the live (non-soft-deleted) tasks in a group. Captured
   * before a group hard-delete so the members can be touched AFTER the FK
   * `SET NULL` fires, ensuring any delta sees their post-delete `groupId = null`
   * state rather than a stale intermediate.
   */
  async findIdsByGroup(groupId: string): Promise<string[]> {
    const tasks = await this.taskRepository.find({
      where: { groupId },
      select: { id: true },
    });

    return tasks.map((task) => task.id);
  }

  /**
   * Bumps `updatedAt` on the given task ids via one targeted UPDATE. No-op for an
   * empty id list.
   */
  async touchByIds(taskIds: string[]): Promise<void> {
    if (taskIds.length === 0) return;

    await this.taskRepository.update(
      { id: In(taskIds) },
      { updatedAt: new Date() },
    );
  }
}
