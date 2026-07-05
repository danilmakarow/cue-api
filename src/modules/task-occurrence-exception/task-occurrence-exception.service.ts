import { Injectable } from '@nestjs/common';
import { In, MoreThan } from 'typeorm';

import { TaskOccurrenceException } from '@/modules/database/entities';
import {
  TaskDatabaseService,
  TaskOccurrenceExceptionDatabaseService,
} from '@/modules/database/services';

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
    private readonly taskDatabaseService: TaskDatabaseService,
  ) {}

  /**
   * Returns every exception row recorded for the given task.
   */
  async findForTask(taskId: string): Promise<TaskOccurrenceException[]> {
    return this.taskOccurrenceExceptionDatabaseService.findAllBy({ taskId });
  }

  /**
   * Returns the exception rows for the given task ids that changed strictly
   * after `since`. Backs the delta endpoint: exceptions are hard-deleted (no
   * tombstone), so a removal is made visible to the client by the parent Task's
   * `updatedAt` touch rather than appearing here. Returns an empty array when
   * no task ids are supplied.
   */
  async findChangedForTasks(
    taskIds: string[],
    since: Date,
  ): Promise<TaskOccurrenceException[]> {
    if (taskIds.length === 0) return [];

    return this.taskOccurrenceExceptionDatabaseService.findAllBy({
      taskId: In(taskIds),
      updatedAt: MoreThan(since),
    });
  }

  /**
   * Returns the single override row for the occurrence identified by
   * `(taskId, originalStart)`, or null when none exists. Backs the assistant's
   * `this`-scope move gate, which must know the occurrence's CURRENT overridden
   * span (a prior length change) so a start-only move slides that true span
   * rather than the master duration.
   */
  async findOverride(
    taskId: string,
    originalStart: Date,
  ): Promise<TaskOccurrenceException | null> {
    return this.taskOccurrenceExceptionDatabaseService.findOneBy({
      taskId,
      originalStartAt: originalStart,
    });
  }

  /**
   * Hard-deletes the exception row for `(taskId, originalStart)`, if any. Used
   * when a materialized override child absorbs the pre-existing exception's span
   * / title / completion — suppression is then carried by the child, and the
   * exception must not linger (it has no tombstone). No-op when none exists.
   */
  async deleteForSlot(taskId: string, originalStart: Date): Promise<void> {
    await this.taskOccurrenceExceptionDatabaseService.delete({
      taskId,
      originalStartAt: originalStart,
    });
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

      const saved =
        await this.taskOccurrenceExceptionDatabaseService.save(existing);

      // Bump the parent Task.updatedAt so this exception write is visible to the
      // delta endpoint (the parent is otherwise untouched by an exception save).
      await this.taskDatabaseService.touchUpdatedAt(taskId);

      return saved;
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

    const saved =
      await this.taskOccurrenceExceptionDatabaseService.save(created);

    // Same touch on the create path: a brand-new override must surface in the
    // parent series' delta window.
    await this.taskDatabaseService.touchUpdatedAt(taskId);

    return saved;
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
