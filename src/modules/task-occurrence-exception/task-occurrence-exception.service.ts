import { Injectable } from '@nestjs/common';

import { TaskOccurrenceException } from '@/modules/database/entities';
import { TaskOccurrenceExceptionDatabaseService } from '@/modules/database/services';

/**
 * The mutable per-instance override fields an upsert may set. `originalStart`
 * identifies the instance and is not itself mutable through this surface.
 */
export interface OccurrenceOverrideChanges {
  overrideStartAt?: Date | null;
  overrideEndAt?: Date | null;
  overrideTitle?: string | null;
  isSkipped?: boolean;
  completedAt?: Date | null;
}

/**
 * Service handling per-occurrence overrides (skip / reschedule / rename /
 * completion) on recurring tasks, keyed by `(taskId, originalStartAt)`.
 */
@Injectable()
export class TaskOccurrenceExceptionService {
  constructor(
    private readonly taskOccurrenceExceptionDatabaseService: TaskOccurrenceExceptionDatabaseService,
  ) {}

  /**
   * Returns every exception row recorded for the given task.
   */
  async findForTask(taskId: string): Promise<TaskOccurrenceException[]> {
    return this.taskOccurrenceExceptionDatabaseService.findAllBy({ taskId });
  }

  /**
   * Upserts the override for a single occurrence identified by
   * `(taskId, originalStart)`: mutates the existing row when present, otherwise
   * creates one. Backed by the unique constraint, so concurrent writers
   * converge to last-writer-wins on fields without duplicate rows. Short-circuits
   * when the provided changes leave the row untouched.
   */
  async upsertOverride(
    taskId: string,
    originalStart: Date,
    changes: OccurrenceOverrideChanges,
  ): Promise<TaskOccurrenceException> {
    const existing =
      await this.taskOccurrenceExceptionDatabaseService.findOneBy({
        taskId,
        originalStartAt: originalStart,
      });

    if (existing) {
      const mutated = this.applyChanges(existing, changes);

      if (!mutated) return existing;

      return this.taskOccurrenceExceptionDatabaseService.save(existing);
    }

    const created = this.taskOccurrenceExceptionDatabaseService.createInstance({
      taskId,
      originalStartAt: originalStart,
      isSkipped: changes.isSkipped ?? false,
      overrideStartAt: changes.overrideStartAt ?? null,
      overrideEndAt: changes.overrideEndAt ?? null,
      overrideTitle: changes.overrideTitle ?? null,
      completedAt: changes.completedAt ?? null,
    });

    return this.taskOccurrenceExceptionDatabaseService.save(created);
  }

  /**
   * Applies only the supplied fields onto an existing exception row in place,
   * returning whether any field actually changed.
   */
  private applyChanges(
    exception: TaskOccurrenceException,
    changes: OccurrenceOverrideChanges,
  ): boolean {
    let changed = false;

    if (
      changes.overrideStartAt !== undefined &&
      !this.datesEqual(changes.overrideStartAt, exception.overrideStartAt)
    ) {
      exception.overrideStartAt = changes.overrideStartAt;
      changed = true;
    }

    if (
      changes.overrideEndAt !== undefined &&
      !this.datesEqual(changes.overrideEndAt, exception.overrideEndAt)
    ) {
      exception.overrideEndAt = changes.overrideEndAt;
      changed = true;
    }

    if (
      changes.overrideTitle !== undefined &&
      changes.overrideTitle !== exception.overrideTitle
    ) {
      exception.overrideTitle = changes.overrideTitle;
      changed = true;
    }

    if (
      changes.isSkipped !== undefined &&
      changes.isSkipped !== exception.isSkipped
    ) {
      exception.isSkipped = changes.isSkipped;
      changed = true;
    }

    if (
      changes.completedAt !== undefined &&
      !this.datesEqual(changes.completedAt, exception.completedAt)
    ) {
      exception.completedAt = changes.completedAt;
      changed = true;
    }

    return changed;
  }

  /**
   * Compares two nullable dates by their epoch value, treating two nulls as equal.
   */
  private datesEqual(left: Date | null, right: Date | null): boolean {
    if (left === null || right === null) return left === right;

    return left.getTime() === right.getTime();
  }
}
