import { ForbiddenException, NotFoundException } from '@nestjs/common';

import { TaskGroupService } from './task-group.service';
import {
  Calendar,
  RecurrenceEndType,
  RecurrenceFrequency,
  TaskGroup,
} from '@/modules/database/entities';

/**
 * Builds a TaskGroupDatabaseService stub exposing only the helpers the service
 * calls. `createInstance` echoes the partial so assertions can inspect it.
 */
const buildGroupDatabaseService = () => ({
  createInstance: jest.fn((partial: Partial<TaskGroup>) => ({ ...partial })),
  save: jest.fn((entity: TaskGroup) =>
    Promise.resolve({ ...entity, id: entity.id ?? 'group-1' }),
  ),
  findOneBy: jest.fn().mockResolvedValue(null),
  findOne: jest.fn().mockResolvedValue(null),
  findAll: jest.fn().mockResolvedValue([]),
  findAllByCalendar: jest.fn().mockResolvedValue([]),
  delete: jest.fn().mockResolvedValue({ affected: 1 }),
});

/**
 * Builds a CalendarDatabaseService stub for ownership checks and owned-calendar
 * enumeration.
 */
const buildCalendarDatabaseService = () => ({
  findOneBy: jest.fn().mockResolvedValue(null),
  findAllByOwner: jest.fn().mockResolvedValue([]),
});

/**
 * Builds a calendar owned by the given user.
 */
const ownedCalendar = (id: string, ownerId = 'user-1'): Calendar =>
  ({ id, ownerId }) as Calendar;

describe('TaskGroupService', () => {
  describe('create', () => {
    it('validates calendar ownership then builds and saves the group', async () => {
      const groupDb = buildGroupDatabaseService();
      const calendarDb = buildCalendarDatabaseService();

      calendarDb.findOneBy.mockResolvedValue(ownedCalendar('cal-1'));

      const service = new TaskGroupService(
        groupDb as never,
        calendarDb as never,
      );

      const result = await service.create('user-1', {
        calendarId: 'cal-1',
        name: 'Work',
      });

      expect(calendarDb.findOneBy).toHaveBeenCalledWith({ id: 'cal-1' });
      expect(groupDb.createInstance).toHaveBeenCalledWith(
        expect.objectContaining({
          calendarId: 'cal-1',
          name: 'Work',
          color: null,
          icon: null,
          requiresCompletion: null,
          defaultNotificationStrategyId: null,
          recurrenceConfig: null,
          sortOrder: 0,
        }),
      );
      expect(groupDb.save).toHaveBeenCalledTimes(1);
      expect(result.id).toBe('group-1');
    });

    it('stores the inline recurrence config when recurrence is provided', async () => {
      const groupDb = buildGroupDatabaseService();
      const calendarDb = buildCalendarDatabaseService();

      calendarDb.findOneBy.mockResolvedValue(ownedCalendar('cal-1'));

      const service = new TaskGroupService(
        groupDb as never,
        calendarDb as never,
      );

      await service.create('user-1', {
        calendarId: 'cal-1',
        name: 'Work',
        recurrence: { frequency: RecurrenceFrequency.DAILY },
      });

      expect(groupDb.createInstance).toHaveBeenCalledWith(
        expect.objectContaining({
          recurrenceConfig: {
            frequency: RecurrenceFrequency.DAILY,
            interval: 1,
            byWeekday: null,
            byMonthDay: null,
            byMonth: null,
            endType: RecurrenceEndType.NEVER,
            endDate: null,
            count: null,
          },
        }),
      );
    });

    it('rejects when the calendar belongs to another user', async () => {
      const groupDb = buildGroupDatabaseService();
      const calendarDb = buildCalendarDatabaseService();

      calendarDb.findOneBy.mockResolvedValue(ownedCalendar('cal-1', 'someone'));

      const service = new TaskGroupService(
        groupDb as never,
        calendarDb as never,
      );

      await expect(
        service.create('user-1', { calendarId: 'cal-1', name: 'Work' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(groupDb.save).not.toHaveBeenCalled();
    });

    it('rejects when the calendar does not exist', async () => {
      const groupDb = buildGroupDatabaseService();
      const calendarDb = buildCalendarDatabaseService();

      const service = new TaskGroupService(
        groupDb as never,
        calendarDb as never,
      );

      await expect(
        service.create('user-1', { calendarId: 'missing', name: 'Work' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('findAllForUser', () => {
    it('returns groups across every owned calendar ordered by sortOrder', async () => {
      const groupDb = buildGroupDatabaseService();
      const calendarDb = buildCalendarDatabaseService();
      const groups = [{ id: 'g1' }, { id: 'g2' }] as TaskGroup[];

      calendarDb.findAllByOwner.mockResolvedValue([
        ownedCalendar('cal-1'),
        ownedCalendar('cal-2'),
      ]);
      groupDb.findAll.mockResolvedValue(groups);

      const service = new TaskGroupService(
        groupDb as never,
        calendarDb as never,
      );

      const result = await service.findAllForUser('user-1');

      expect(groupDb.findAll).toHaveBeenCalledWith(
        expect.objectContaining({ order: { sortOrder: 'ASC' } }),
      );
      expect(result).toBe(groups);
    });

    it('short-circuits to an empty array when the user owns no calendars', async () => {
      const groupDb = buildGroupDatabaseService();
      const calendarDb = buildCalendarDatabaseService();

      const service = new TaskGroupService(
        groupDb as never,
        calendarDb as never,
      );

      const result = await service.findAllForUser('user-1');

      expect(result).toEqual([]);
      expect(groupDb.findAll).not.toHaveBeenCalled();
    });
  });

  describe('findAllByCalendar', () => {
    it('asserts ownership then delegates to the ordered calendar finder', async () => {
      const groupDb = buildGroupDatabaseService();
      const calendarDb = buildCalendarDatabaseService();
      const groups = [{ id: 'g1' }] as TaskGroup[];

      calendarDb.findOneBy.mockResolvedValue(ownedCalendar('cal-1'));
      groupDb.findAll.mockResolvedValue(groups);

      const service = new TaskGroupService(
        groupDb as never,
        calendarDb as never,
      );

      const result = await service.findAllByCalendar('user-1', 'cal-1');

      expect(groupDb.findAll).toHaveBeenCalledWith(
        expect.objectContaining({ where: { calendarId: 'cal-1' } }),
      );
      expect(result).toBe(groups);
    });
  });

  describe('findByName', () => {
    it('returns ALL matches so the caller can disambiguate duplicates', async () => {
      const groupDb = buildGroupDatabaseService();
      const calendarDb = buildCalendarDatabaseService();
      // Same name in two different calendars — both must come back.
      const matches = [
        { id: 'g1', calendarId: 'cal-1', name: 'Errands' },
        { id: 'g2', calendarId: 'cal-2', name: 'Errands' },
      ] as TaskGroup[];

      calendarDb.findAllByOwner.mockResolvedValue([
        ownedCalendar('cal-1'),
        ownedCalendar('cal-2'),
      ]);
      groupDb.findAll.mockResolvedValue(matches);

      const service = new TaskGroupService(
        groupDb as never,
        calendarDb as never,
      );

      const result = await service.findByName('user-1', 'Errands');

      expect(groupDb.findAll).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ name: 'Errands' }),
        }),
      );
      expect(result).toHaveLength(2);
      expect(result.map((group) => group.id)).toEqual(['g1', 'g2']);
    });

    it('returns empty when the user owns no calendars', async () => {
      const groupDb = buildGroupDatabaseService();
      const calendarDb = buildCalendarDatabaseService();

      const service = new TaskGroupService(
        groupDb as never,
        calendarDb as never,
      );

      const result = await service.findByName('user-1', 'Errands');

      expect(result).toEqual([]);
      expect(groupDb.findAll).not.toHaveBeenCalled();
    });
  });

  describe('rename', () => {
    it('mutates the name and saves after asserting ownership', async () => {
      const groupDb = buildGroupDatabaseService();
      const calendarDb = buildCalendarDatabaseService();
      const group = {
        id: 'group-1',
        calendarId: 'cal-1',
        name: 'Old',
      } as TaskGroup;

      groupDb.findOneBy.mockResolvedValue(group);
      calendarDb.findOneBy.mockResolvedValue(ownedCalendar('cal-1'));

      const service = new TaskGroupService(
        groupDb as never,
        calendarDb as never,
      );

      await service.rename('user-1', 'group-1', 'New');

      expect(group.name).toBe('New');
      expect(groupDb.save).toHaveBeenCalledWith(group);
    });

    it('short-circuits without saving when the name is unchanged', async () => {
      const groupDb = buildGroupDatabaseService();
      const calendarDb = buildCalendarDatabaseService();
      const group = {
        id: 'group-1',
        calendarId: 'cal-1',
        name: 'Same',
      } as TaskGroup;

      groupDb.findOneBy.mockResolvedValue(group);
      calendarDb.findOneBy.mockResolvedValue(ownedCalendar('cal-1'));

      const service = new TaskGroupService(
        groupDb as never,
        calendarDb as never,
      );

      const result = await service.rename('user-1', 'group-1', 'Same');

      expect(groupDb.save).not.toHaveBeenCalled();
      expect(result).toBe(group);
    });

    it("rejects a rename on a group in another user's calendar", async () => {
      const groupDb = buildGroupDatabaseService();
      const calendarDb = buildCalendarDatabaseService();
      const group = {
        id: 'group-1',
        calendarId: 'cal-1',
        name: 'Old',
      } as TaskGroup;

      groupDb.findOneBy.mockResolvedValue(group);
      calendarDb.findOneBy.mockResolvedValue(ownedCalendar('cal-1', 'someone'));

      const service = new TaskGroupService(
        groupDb as never,
        calendarDb as never,
      );

      await expect(
        service.rename('user-1', 'group-1', 'New'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('remove', () => {
    it('deletes the group after asserting ownership', async () => {
      const groupDb = buildGroupDatabaseService();
      const calendarDb = buildCalendarDatabaseService();
      const group = { id: 'group-1', calendarId: 'cal-1' } as TaskGroup;

      groupDb.findOneBy.mockResolvedValue(group);
      calendarDb.findOneBy.mockResolvedValue(ownedCalendar('cal-1'));

      const service = new TaskGroupService(
        groupDb as never,
        calendarDb as never,
      );

      await service.remove('user-1', 'group-1');

      expect(groupDb.delete).toHaveBeenCalledWith('group-1');
    });

    it('throws 404 when the group does not exist', async () => {
      const groupDb = buildGroupDatabaseService();
      const calendarDb = buildCalendarDatabaseService();

      const service = new TaskGroupService(
        groupDb as never,
        calendarDb as never,
      );

      await expect(service.remove('user-1', 'missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('update', () => {
    const groupWithConfig = (
      recurrenceConfig: TaskGroup['recurrenceConfig'] = null,
    ): TaskGroup =>
      ({
        id: 'group-1',
        calendarId: 'cal-1',
        name: 'My Group',
        color: null,
        icon: null,
        sortOrder: 0,
        requiresCompletion: null,
        recurrenceConfig,
      }) as unknown as TaskGroup;

    it('updates the name and saves the same row (no re-load)', async () => {
      const groupDb = buildGroupDatabaseService();
      const calendarDb = buildCalendarDatabaseService();
      const group = groupWithConfig(null);

      groupDb.findOneBy.mockResolvedValue(group);
      calendarDb.findOneBy.mockResolvedValue(ownedCalendar('cal-1'));

      const service = new TaskGroupService(
        groupDb as never,
        calendarDb as never,
      );

      const result = await service.update('user-1', 'group-1', {
        name: 'Updated',
      });

      expect(groupDb.save).toHaveBeenCalledTimes(1);
      expect(result.name).toBe('Updated');
    });

    it('sets the inline recurrence config when recurrence is provided', async () => {
      const groupDb = buildGroupDatabaseService();
      const calendarDb = buildCalendarDatabaseService();
      const group = groupWithConfig(null);

      groupDb.findOneBy.mockResolvedValue(group);
      calendarDb.findOneBy.mockResolvedValue(ownedCalendar('cal-1'));

      const service = new TaskGroupService(
        groupDb as never,
        calendarDb as never,
      );

      await service.update('user-1', 'group-1', {
        recurrence: { frequency: RecurrenceFrequency.DAILY },
      });

      expect(group.recurrenceConfig).toEqual({
        frequency: RecurrenceFrequency.DAILY,
        interval: 1,
        byWeekday: null,
        byMonthDay: null,
        byMonth: null,
        endType: RecurrenceEndType.NEVER,
        endDate: null,
        count: null,
      });
      expect(groupDb.save).toHaveBeenCalledTimes(1);
    });

    it('clears the inline recurrence config when recurrence: null is passed', async () => {
      const groupDb = buildGroupDatabaseService();
      const calendarDb = buildCalendarDatabaseService();
      const group = groupWithConfig({
        frequency: RecurrenceFrequency.DAILY,
        interval: 1,
        byWeekday: null,
        byMonthDay: null,
        byMonth: null,
        endType: RecurrenceEndType.NEVER,
        endDate: null,
        count: null,
      });

      groupDb.findOneBy.mockResolvedValue(group);
      calendarDb.findOneBy.mockResolvedValue(ownedCalendar('cal-1'));

      const service = new TaskGroupService(
        groupDb as never,
        calendarDb as never,
      );

      await service.update('user-1', 'group-1', { recurrence: null });

      expect(group.recurrenceConfig).toBeNull();
      expect(groupDb.save).toHaveBeenCalledTimes(1);
    });

    it('sets the group default requiresCompletion', async () => {
      const groupDb = buildGroupDatabaseService();
      const calendarDb = buildCalendarDatabaseService();
      const group = groupWithConfig(null);

      groupDb.findOneBy.mockResolvedValue(group);
      calendarDb.findOneBy.mockResolvedValue(ownedCalendar('cal-1'));

      const service = new TaskGroupService(
        groupDb as never,
        calendarDb as never,
      );

      await service.update('user-1', 'group-1', { requiresCompletion: true });

      expect(group.requiresCompletion).toBe(true);
      expect(groupDb.save).toHaveBeenCalledTimes(1);
    });

    it('short-circuits without saving when nothing changes', async () => {
      const groupDb = buildGroupDatabaseService();
      const calendarDb = buildCalendarDatabaseService();
      const group = groupWithConfig(null);

      groupDb.findOneBy.mockResolvedValue(group);
      calendarDb.findOneBy.mockResolvedValue(ownedCalendar('cal-1'));

      const service = new TaskGroupService(
        groupDb as never,
        calendarDb as never,
      );

      // Passing the same name — no change, should not call save.
      await service.update('user-1', 'group-1', { name: 'My Group' });

      expect(groupDb.save).not.toHaveBeenCalled();
    });
  });
});
