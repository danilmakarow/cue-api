import { NotificationRuleService } from './notification-rule.service';
import { NotificationChannel } from '@/modules/database/entities';

/**
 * Builds a notification-rule-database stub. `createInstance` echoes its partial
 * (with an id) so the created rows can be asserted; `save` resolves its input.
 */
const buildDb = () => {
  let counter = 0;

  return {
    findAll: jest.fn().mockResolvedValue([]),
    delete: jest.fn().mockResolvedValue({ affected: 0 }),
    createInstance: jest.fn().mockImplementation((partial: object) => ({
      id: `rule-${++counter}`,
      ...partial,
    })),
    save: jest
      .fn()
      .mockImplementation((entity: object) => Promise.resolve(entity)),
  };
};

describe('NotificationRuleService (per-task reminders, S1)', () => {
  describe('createForTask', () => {
    it('persists each reminder as a taskId-linked rule (strategy null)', async () => {
      const db = buildDb();
      const service = new NotificationRuleService(db as never);

      const result = await service.createForTask('task-1', [
        { offsetMinutes: -15, channel: NotificationChannel.PUSH },
        { offsetMinutes: 30, channel: NotificationChannel.TELEGRAM },
      ]);

      expect(db.save).toHaveBeenCalledTimes(2);
      expect(db.createInstance).toHaveBeenNthCalledWith(1, {
        taskId: 'task-1',
        strategyId: null,
        offsetMinutes: -15,
        channel: NotificationChannel.PUSH,
        messageTemplate: null,
      });
      expect(result).toHaveLength(2);
    });

    it('is a no-op for an empty reminder list', async () => {
      const db = buildDb();
      const service = new NotificationRuleService(db as never);

      const result = await service.createForTask('task-1', []);

      expect(result).toEqual([]);
      expect(db.save).not.toHaveBeenCalled();
    });
  });

  describe('replaceForTask', () => {
    it('deletes the existing rules then creates the new set', async () => {
      const db = buildDb();
      const service = new NotificationRuleService(db as never);

      await service.replaceForTask('task-1', [
        { offsetMinutes: -10, channel: NotificationChannel.PUSH },
      ]);

      expect(db.delete).toHaveBeenCalledWith({ taskId: 'task-1' });

      const deleteOrder = db.delete.mock.invocationCallOrder[0];
      const saveOrder = db.save.mock.invocationCallOrder[0];

      expect(deleteOrder).toBeLessThan(saveOrder);
    });

    it('clears the reminders when given an empty array', async () => {
      const db = buildDb();
      const service = new NotificationRuleService(db as never);

      const result = await service.replaceForTask('task-1', []);

      expect(db.delete).toHaveBeenCalledWith({ taskId: 'task-1' });
      expect(db.save).not.toHaveBeenCalled();
      expect(result).toEqual([]);
    });

    it('is a no-op (no delete) when reminders is null', async () => {
      const db = buildDb();
      const service = new NotificationRuleService(db as never);

      await service.replaceForTask('task-1', null);

      expect(db.delete).not.toHaveBeenCalled();
      expect(db.findAll).toHaveBeenCalledWith({
        where: { taskId: 'task-1' },
        order: { offsetMinutes: 'ASC' },
      });
    });
  });

  describe('listByTask', () => {
    it('reads taskId-linked rules ordered by offset ascending', async () => {
      const db = buildDb();
      const service = new NotificationRuleService(db as never);

      await service.listByTask('task-1');

      expect(db.findAll).toHaveBeenCalledWith({
        where: { taskId: 'task-1' },
        order: { offsetMinutes: 'ASC' },
      });
    });
  });
});
