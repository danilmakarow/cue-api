import { ForbiddenException } from '@nestjs/common';

import { TaskController } from './task.controller';
import { OccurrenceCompletionResult } from './task.service';
import { Task, User } from '@/modules/database/entities';

/**
 * Builds a minimal authenticated user.
 */
const makeUser = (id = 'user-1'): User => ({ id }) as User;

/**
 * Builds a Task fixture with the fields the completion handler reads.
 */
const makeTask = (overrides: Partial<Task> = {}): Task =>
  ({
    id: 'task-1',
    calendarId: 'cal-1',
    completedAt: null,
    ...overrides,
  }) as Task;

describe('TaskController.setCompletion', () => {
  /**
   * Builds a TaskController over a mocked TaskService exposing only the methods
   * the completion handler touches.
   */
  const buildController = () => {
    const taskService = {
      findById: jest.fn(),
      setCompleted: jest.fn(),
      setOccurrenceCompleted: jest.fn(),
    };
    const controller = new TaskController(taskService as never);

    return { controller, taskService };
  };

  describe('series / one-off branch (no occurrenceStart)', () => {
    it('asserts ownership via findById BEFORE setCompleted (IDOR guard)', async () => {
      const { controller, taskService } = buildController();
      const task = makeTask({ completedAt: new Date('2026-06-02T10:00:00Z') });

      taskService.findById.mockResolvedValue(task);
      taskService.setCompleted.mockResolvedValue(task);

      await controller.setCompletion(makeUser(), 'task-1', {
        isCompleted: true,
      });

      // findById must run first (ownership assertion), then setCompleted.
      expect(taskService.findById).toHaveBeenCalledWith('user-1', 'task-1');

      const findOrder = taskService.findById.mock.invocationCallOrder[0];
      const setOrder = taskService.setCompleted.mock.invocationCallOrder[0];

      expect(findOrder).toBeLessThan(setOrder);
    });

    it("does NOT call setCompleted when findById rejects another user's task", async () => {
      const { controller, taskService } = buildController();

      taskService.findById.mockRejectedValue(
        new ForbiddenException('You do not have access to this calendar'),
      );

      await expect(
        controller.setCompletion(makeUser('attacker'), 'task-1', {
          isCompleted: true,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);

      expect(taskService.setCompleted).not.toHaveBeenCalled();
    });

    it('returns the persisted completedAt', async () => {
      const { controller, taskService } = buildController();
      const completedAt = new Date('2026-06-02T10:00:00Z');
      const task = makeTask({ completedAt });

      taskService.findById.mockResolvedValue(task);
      taskService.setCompleted.mockResolvedValue(task);

      const result = await controller.setCompletion(makeUser(), 'task-1', {
        isCompleted: true,
      });

      expect(result).toEqual({
        taskId: 'task-1',
        occurrenceStart: null,
        completedAt: completedAt.toISOString(),
      });
    });
  });

  describe('occurrence branch (occurrenceStart present)', () => {
    it('surfaces the persisted exception completedAt, not a fabricated one', async () => {
      const { controller, taskService } = buildController();
      const persistedAt = new Date('2026-06-02T10:05:00Z');

      taskService.setOccurrenceCompleted.mockResolvedValue({
        completedAt: persistedAt,
        isOccurrenceScoped: true,
      } satisfies OccurrenceCompletionResult);

      const result = await controller.setCompletion(makeUser(), 'task-1', {
        isCompleted: true,
        occurrenceStart: '2026-06-02T09:00:00.000Z',
      });

      expect(result).toEqual({
        taskId: 'task-1',
        occurrenceStart: '2026-06-02T09:00:00.000Z',
        completedAt: persistedAt.toISOString(),
      });
    });

    it('reports occurrenceStart null when the task is non-recurring (collapsed to master)', async () => {
      const { controller, taskService } = buildController();
      const persistedAt = new Date('2026-06-02T10:05:00Z');

      taskService.setOccurrenceCompleted.mockResolvedValue({
        completedAt: persistedAt,
        isOccurrenceScoped: false,
      } satisfies OccurrenceCompletionResult);

      const result = await controller.setCompletion(makeUser(), 'task-1', {
        isCompleted: true,
        occurrenceStart: '2026-06-02T09:00:00.000Z',
      });

      expect(result.occurrenceStart).toBeNull();
      expect(result.completedAt).toBe(persistedAt.toISOString());
    });

    it('reports null completedAt when un-completing an occurrence', async () => {
      const { controller, taskService } = buildController();

      taskService.setOccurrenceCompleted.mockResolvedValue({
        completedAt: null,
        isOccurrenceScoped: true,
      } satisfies OccurrenceCompletionResult);

      const result = await controller.setCompletion(makeUser(), 'task-1', {
        isCompleted: false,
        occurrenceStart: '2026-06-02T09:00:00.000Z',
      });

      expect(result.completedAt).toBeNull();
    });
  });
});
