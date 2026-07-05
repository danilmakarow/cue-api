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
    it('delegates to setCompleted with the current user id (ownership enforced in the service)', async () => {
      const { controller, taskService } = buildController();
      const task = makeTask({ completedAt: new Date('2026-06-02T10:00:00Z') });

      taskService.setCompleted.mockResolvedValue(task);

      await controller.setCompletion(makeUser(), 'task-1', {
        isCompleted: true,
      });

      // Ownership now lives inside setCompleted (it calls findById), so the
      // controller simply forwards the authed user id — no separate pre-check.
      expect(taskService.setCompleted).toHaveBeenCalledWith(
        'user-1',
        'task-1',
        true,
      );
    });

    it("propagates setCompleted's ownership rejection (IDOR guard lives in the service)", async () => {
      const { controller, taskService } = buildController();

      taskService.setCompleted.mockRejectedValue(
        new ForbiddenException('You do not have access to this calendar'),
      );

      await expect(
        controller.setCompletion(makeUser('attacker'), 'task-1', {
          isCompleted: true,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
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

describe('TaskController.search (M1)', () => {
  it('forwards q / groupId / limit and maps rows to search-result DTOs', async () => {
    const taskService = {
      searchTasks: jest.fn().mockResolvedValue([
        makeTask({
          id: 't-hit',
          title: 'Dentist',
          notes: 'card',
          startAt: new Date('2026-06-09T09:00:00.000Z'),
          endAt: null,
          isAllDay: false,
          groupId: 'grp-1',
          group: { color: '#E27921' },
          recurrenceConfig: null,
          timezone: 'Europe/Berlin',
        } as never),
      ]),
    };
    const controller = new TaskController(taskService as never);

    const result = await controller.search(makeUser(), {
      q: 'dent',
      groupId: 'grp-1',
      limit: 10,
    });

    expect(taskService.searchTasks).toHaveBeenCalledWith('user-1', 'dent', {
      groupId: 'grp-1',
      limit: 10,
    });
    expect(result).toEqual([
      {
        taskId: 't-hit',
        calendarId: 'cal-1',
        groupId: 'grp-1',
        groupColorHex: '#E27921',
        title: 'Dentist',
        notes: 'card',
        startAt: '2026-06-09T09:00:00.000Z',
        endAt: null,
        isAllDay: false,
        timezone: 'Europe/Berlin',
        isRecurring: false,
      },
    ]);
  });
});
