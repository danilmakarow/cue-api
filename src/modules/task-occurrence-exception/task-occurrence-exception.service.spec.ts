import { TaskOccurrenceExceptionService } from './task-occurrence-exception.service';
import { TaskOccurrenceException } from '@/modules/database/entities';

/**
 * Builds a database-service stub exposing only the helpers the exception
 * service calls. `createInstance` echoes the partial so assertions can inspect it.
 */
const buildDatabaseService = () => ({
  findAllBy: jest.fn().mockResolvedValue([]),
  findOneBy: jest.fn().mockResolvedValue(null),
  createInstance: jest.fn((partial: Partial<TaskOccurrenceException>) => ({
    ...partial,
  })),
  save: jest.fn((entity: TaskOccurrenceException) =>
    Promise.resolve({ ...entity, id: entity.id ?? 'exc-1' }),
  ),
});

/**
 * Builds a task-database stub exposing only `touchUpdatedAt` — the parent-bump
 * the exception write path now calls so override changes surface in the delta
 * endpoint.
 */
const buildTaskDatabaseService = () => ({
  touchUpdatedAt: jest.fn().mockResolvedValue(undefined),
});

describe('TaskOccurrenceExceptionService', () => {
  describe('findForTask', () => {
    it('reads all exception rows for the task', async () => {
      const databaseService = buildDatabaseService();
      const taskDatabaseService = buildTaskDatabaseService();
      const rows = [{ id: 'exc-1' }] as TaskOccurrenceException[];

      databaseService.findAllBy.mockResolvedValue(rows);

      const service = new TaskOccurrenceExceptionService(
        databaseService as never,
        taskDatabaseService as never,
      );

      const result = await service.findForTask('task-1');

      expect(databaseService.findAllBy).toHaveBeenCalledWith({
        taskId: 'task-1',
      });
      expect(result).toBe(rows);
    });
  });

  describe('upsertOverride — insert path', () => {
    it('creates a new exception when none exists for the coordinate', async () => {
      const databaseService = buildDatabaseService();
      const taskDatabaseService = buildTaskDatabaseService();
      const service = new TaskOccurrenceExceptionService(
        databaseService as never,
        taskDatabaseService as never,
      );
      const originalStart = new Date('2026-06-02T13:00:00.000Z');
      const overrideStartAt = new Date('2026-06-02T18:00:00.000Z');

      const result = await service.upsertOverride('task-1', originalStart, {
        overrideStartAt,
        overrideTitle: 'Moved',
      });

      expect(databaseService.findOneBy).toHaveBeenCalledWith({
        taskId: 'task-1',
        originalStartAt: originalStart,
      });
      expect(databaseService.createInstance).toHaveBeenCalledWith({
        taskId: 'task-1',
        originalStartAt: originalStart,
        isSkipped: false,
        overrideStartAt,
        overrideEndAt: null,
        overrideTitle: 'Moved',
        completedAt: null,
      });
      expect(databaseService.save).toHaveBeenCalledTimes(1);
      expect(result.id).toBe('exc-1');
      // Landmine fix: a new override bumps the parent Task.updatedAt so the
      // delta endpoint sees it.
      expect(taskDatabaseService.touchUpdatedAt).toHaveBeenCalledWith('task-1');
    });

    it('defaults isSkipped to true when creating a skip', async () => {
      const databaseService = buildDatabaseService();
      const taskDatabaseService = buildTaskDatabaseService();
      const service = new TaskOccurrenceExceptionService(
        databaseService as never,
        taskDatabaseService as never,
      );
      const originalStart = new Date('2026-06-02T13:00:00.000Z');

      await service.upsertOverride('task-1', originalStart, {
        isSkipped: true,
      });

      expect(databaseService.createInstance).toHaveBeenCalledWith(
        expect.objectContaining({ isSkipped: true }),
      );
    });
  });

  describe('upsertOverride — update path', () => {
    it('mutates the existing row and saves it', async () => {
      const databaseService = buildDatabaseService();
      const taskDatabaseService = buildTaskDatabaseService();
      const originalStart = new Date('2026-06-02T13:00:00.000Z');
      const existing = {
        id: 'exc-1',
        taskId: 'task-1',
        originalStartAt: originalStart,
        isSkipped: false,
        overrideStartAt: null,
        overrideEndAt: null,
        overrideTitle: null,
        completedAt: null,
      } as TaskOccurrenceException;

      databaseService.findOneBy.mockResolvedValue(existing);

      const service = new TaskOccurrenceExceptionService(
        databaseService as never,
        taskDatabaseService as never,
      );
      const completedAt = new Date('2026-06-02T14:00:00.000Z');

      await service.upsertOverride('task-1', originalStart, { completedAt });

      expect(databaseService.createInstance).not.toHaveBeenCalled();
      expect(existing.completedAt).toEqual(completedAt);
      expect(databaseService.save).toHaveBeenCalledWith(existing);
      // Landmine fix: mutating an existing override also bumps the parent.
      expect(taskDatabaseService.touchUpdatedAt).toHaveBeenCalledWith('task-1');
    });

    it('short-circuits without saving when nothing changed', async () => {
      const databaseService = buildDatabaseService();
      const taskDatabaseService = buildTaskDatabaseService();
      const originalStart = new Date('2026-06-02T13:00:00.000Z');
      const existingCompletedAt = new Date('2026-06-02T14:00:00.000Z');
      const existing = {
        id: 'exc-1',
        taskId: 'task-1',
        originalStartAt: originalStart,
        isSkipped: true,
        overrideStartAt: null,
        overrideEndAt: null,
        overrideTitle: 'Already',
        completedAt: existingCompletedAt,
      } as TaskOccurrenceException;

      databaseService.findOneBy.mockResolvedValue(existing);

      const service = new TaskOccurrenceExceptionService(
        databaseService as never,
        taskDatabaseService as never,
      );

      const result = await service.upsertOverride('task-1', originalStart, {
        isSkipped: true,
        overrideTitle: 'Already',
        completedAt: new Date(existingCompletedAt.getTime()), // equal by value
      });

      expect(databaseService.save).not.toHaveBeenCalled();
      expect(result).toBe(existing);
      // No write happened, so the parent must not be touched either.
      expect(taskDatabaseService.touchUpdatedAt).not.toHaveBeenCalled();
    });

    it('clears a field when an override is explicitly set back to null', async () => {
      const databaseService = buildDatabaseService();
      const taskDatabaseService = buildTaskDatabaseService();
      const originalStart = new Date('2026-06-02T13:00:00.000Z');
      const existing = {
        id: 'exc-1',
        taskId: 'task-1',
        originalStartAt: originalStart,
        isSkipped: false,
        overrideStartAt: new Date('2026-06-02T18:00:00.000Z'),
        overrideEndAt: null,
        overrideTitle: null,
        completedAt: null,
      } as TaskOccurrenceException;

      databaseService.findOneBy.mockResolvedValue(existing);

      const service = new TaskOccurrenceExceptionService(
        databaseService as never,
        taskDatabaseService as never,
      );

      await service.upsertOverride('task-1', originalStart, {
        overrideStartAt: null,
      });

      expect(existing.overrideStartAt).toBeNull();
      expect(databaseService.save).toHaveBeenCalledWith(existing);
    });
  });
});
