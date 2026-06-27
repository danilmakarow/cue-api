import { ForbiddenException, NotFoundException } from '@nestjs/common';

// `@Transactional()` (used by `reorder`) requires a registered transactional
// data source at runtime, which a pure unit spec has no DB to provide. Stub the
// decorator to a pass-through so the method's logic can be exercised directly;
// the real transaction wrapping is covered at the integration layer.
jest.mock('typeorm-transactional', () => ({
  Transactional: () => () => undefined,
}));

import { TaskGroupService } from './task-group.service';
import {
  Calendar,
  RecurrenceEndType,
  RecurrenceFrequency,
  TaskColor,
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
            bySetPos: null,
            monthlyAnchor: null,
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

  describe('reorder', () => {
    /**
     * Builds a TaskGroup carrying an id, owning calendar, and current sortOrder.
     */
    const reorderable = (
      id: string,
      calendarId: string,
      sortOrder: number,
    ): TaskGroup => ({ id, calendarId, sortOrder }) as TaskGroup;

    it('assigns sortOrder by array index and saves the changed rows', async () => {
      const groupDb = buildGroupDatabaseService();
      const calendarDb = buildCalendarDatabaseService();
      // Stored order is g1=0, g2=1; request flips them to g2, g1.
      const g1 = reorderable('g1', 'cal-1', 0);
      const g2 = reorderable('g2', 'cal-1', 1);

      groupDb.findAll.mockResolvedValue([g1, g2]);
      calendarDb.findAllByOwner.mockResolvedValue([ownedCalendar('cal-1')]);

      const service = new TaskGroupService(
        groupDb as never,
        calendarDb as never,
      );

      const result = await service.reorder('user-1', ['g2', 'g1']);

      expect(g2.sortOrder).toBe(0);
      expect(g1.sortOrder).toBe(1);
      expect(groupDb.save).toHaveBeenCalledTimes(2);
      // Returned in the requested order.
      expect(result.map((group) => group.id)).toEqual(['g2', 'g1']);
    });

    it('only saves rows whose sortOrder actually changed', async () => {
      const groupDb = buildGroupDatabaseService();
      const calendarDb = buildCalendarDatabaseService();
      // g1 already at index 0; only g2 moves.
      const g1 = reorderable('g1', 'cal-1', 0);
      const g2 = reorderable('g2', 'cal-1', 5);

      groupDb.findAll.mockResolvedValue([g1, g2]);
      calendarDb.findAllByOwner.mockResolvedValue([ownedCalendar('cal-1')]);

      const service = new TaskGroupService(
        groupDb as never,
        calendarDb as never,
      );

      await service.reorder('user-1', ['g1', 'g2']);

      expect(g2.sortOrder).toBe(1);
      expect(groupDb.save).toHaveBeenCalledTimes(1);
      expect(groupDb.save).toHaveBeenCalledWith(g2);
    });

    it('reorders groups spanning multiple owned calendars', async () => {
      const groupDb = buildGroupDatabaseService();
      const calendarDb = buildCalendarDatabaseService();
      const g1 = reorderable('g1', 'cal-1', 0);
      const g2 = reorderable('g2', 'cal-2', 0);

      groupDb.findAll.mockResolvedValue([g1, g2]);
      calendarDb.findAllByOwner.mockResolvedValue([
        ownedCalendar('cal-1'),
        ownedCalendar('cal-2'),
      ]);

      const service = new TaskGroupService(
        groupDb as never,
        calendarDb as never,
      );

      await service.reorder('user-1', ['g2', 'g1']);

      expect(g2.sortOrder).toBe(0);
      expect(g1.sortOrder).toBe(1);
    });

    it('throws 404 when an id does not resolve to a group', async () => {
      const groupDb = buildGroupDatabaseService();
      const calendarDb = buildCalendarDatabaseService();

      // Asked for two ids, only one exists.
      groupDb.findAll.mockResolvedValue([reorderable('g1', 'cal-1', 0)]);
      calendarDb.findAllByOwner.mockResolvedValue([ownedCalendar('cal-1')]);

      const service = new TaskGroupService(
        groupDb as never,
        calendarDb as never,
      );

      await expect(
        service.reorder('user-1', ['g1', 'missing']),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(groupDb.save).not.toHaveBeenCalled();
    });

    it('throws 403 when any group belongs to a calendar the user does not own', async () => {
      const groupDb = buildGroupDatabaseService();
      const calendarDb = buildCalendarDatabaseService();
      const g1 = reorderable('g1', 'cal-1', 0);
      const foreign = reorderable('g2', 'cal-foreign', 0);

      groupDb.findAll.mockResolvedValue([g1, foreign]);
      // User owns only cal-1.
      calendarDb.findAllByOwner.mockResolvedValue([ownedCalendar('cal-1')]);

      const service = new TaskGroupService(
        groupDb as never,
        calendarDb as never,
      );

      await expect(
        service.reorder('user-1', ['g1', 'g2']),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(groupDb.save).not.toHaveBeenCalled();
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
        bySetPos: null,
        monthlyAnchor: null,
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
        bySetPos: null,
        monthlyAnchor: null,
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

  describe('update — per field', () => {
    /**
     * Builds a fully-populated TaskGroup carrying explicit starting values for
     * every mutable field, so a per-field update test can prove it changes the
     * one field under test (and only that field) and that the row is persisted.
     */
    const seededGroup = (overrides: Partial<TaskGroup> = {}): TaskGroup =>
      ({
        id: 'group-1',
        calendarId: 'cal-1',
        name: 'Seed Name',
        color: null,
        icon: null,
        sortOrder: 0,
        requiresCompletion: null,
        recurrenceConfig: null,
        ...overrides,
      }) as unknown as TaskGroup;

    /**
     * Wires the two database stubs so `findOwnedGroup` resolves to `group` under
     * an owned calendar, then returns a ready service plus the stubs for
     * assertions. Centralizes the repetitive arrange step of each per-field test.
     */
    const arrangeUpdate = (group: TaskGroup) => {
      const groupDb = buildGroupDatabaseService();
      const calendarDb = buildCalendarDatabaseService();

      groupDb.findOneBy.mockResolvedValue(group);
      calendarDb.findOneBy.mockResolvedValue(ownedCalendar('cal-1'));

      const service = new TaskGroupService(
        groupDb as never,
        calendarDb as never,
      );

      return { service, groupDb, calendarDb };
    };

    /** A complete recurrence config used as a persisted starting state. */
    const dailyConfig = (): TaskGroup['recurrenceConfig'] => ({
      frequency: RecurrenceFrequency.DAILY,
      interval: 1,
      byWeekday: null,
      byMonthDay: null,
      byMonth: null,
      bySetPos: null,
      monthlyAnchor: null,
      endType: RecurrenceEndType.NEVER,
      endDate: null,
      count: null,
    });

    it('name — persists a new name on update', async () => {
      const group = seededGroup({ name: 'Old Name' });
      const { service, groupDb } = arrangeUpdate(group);

      const result = await service.update('user-1', 'group-1', {
        name: 'New Name',
      });

      expect(group.name).toBe('New Name');
      expect(result.name).toBe('New Name');
      expect(groupDb.save).toHaveBeenCalledTimes(1);
      expect(groupDb.save).toHaveBeenCalledWith(group);
    });

    it('color — persists a preset color', async () => {
      const group = seededGroup({ color: null });
      const { service, groupDb } = arrangeUpdate(group);

      const result = await service.update('user-1', 'group-1', {
        color: TaskColor.BLUE,
      });

      expect(group.color).toBe(TaskColor.BLUE);
      expect(result.color).toBe(TaskColor.BLUE);
      expect(groupDb.save).toHaveBeenCalledTimes(1);
    });

    it('color — persists a custom #hex color', async () => {
      const group = seededGroup({ color: TaskColor.BLUE });
      const { service, groupDb } = arrangeUpdate(group);

      const result = await service.update('user-1', 'group-1', {
        color: '#A1B2C3',
      });

      expect(group.color).toBe('#A1B2C3');
      expect(result.color).toBe('#A1B2C3');
      expect(groupDb.save).toHaveBeenCalledTimes(1);
    });

    it('color — clears the color to null', async () => {
      const group = seededGroup({ color: TaskColor.BLUE });
      const { service, groupDb } = arrangeUpdate(group);

      const result = await service.update('user-1', 'group-1', { color: null });

      expect(group.color).toBeNull();
      expect(result.color).toBeNull();
      expect(groupDb.save).toHaveBeenCalledTimes(1);
    });

    it('icon — persists a new icon', async () => {
      const group = seededGroup({ icon: null });
      const { service, groupDb } = arrangeUpdate(group);

      const result = await service.update('user-1', 'group-1', {
        icon: 'star.fill',
      });

      expect(group.icon).toBe('star.fill');
      expect(result.icon).toBe('star.fill');
      expect(groupDb.save).toHaveBeenCalledTimes(1);
    });

    it('icon — clears the icon to null', async () => {
      const group = seededGroup({ icon: 'star.fill' });
      const { service, groupDb } = arrangeUpdate(group);

      const result = await service.update('user-1', 'group-1', { icon: null });

      expect(group.icon).toBeNull();
      expect(result.icon).toBeNull();
      expect(groupDb.save).toHaveBeenCalledTimes(1);
    });

    it('requiresCompletion — persists a boolean default', async () => {
      const group = seededGroup({ requiresCompletion: null });
      const { service, groupDb } = arrangeUpdate(group);

      const result = await service.update('user-1', 'group-1', {
        requiresCompletion: true,
      });

      expect(group.requiresCompletion).toBe(true);
      expect(result.requiresCompletion).toBe(true);
      expect(groupDb.save).toHaveBeenCalledTimes(1);
    });

    it('requiresCompletion — clears the default to null', async () => {
      const group = seededGroup({ requiresCompletion: true });
      const { service, groupDb } = arrangeUpdate(group);

      const result = await service.update('user-1', 'group-1', {
        requiresCompletion: null,
      });

      expect(group.requiresCompletion).toBeNull();
      expect(result.requiresCompletion).toBeNull();
      expect(groupDb.save).toHaveBeenCalledTimes(1);
    });

    it('sortOrder — persists a reorder', async () => {
      const group = seededGroup({ sortOrder: 0 });
      const { service, groupDb } = arrangeUpdate(group);

      const result = await service.update('user-1', 'group-1', {
        sortOrder: 5,
      });

      expect(group.sortOrder).toBe(5);
      expect(result.sortOrder).toBe(5);
      expect(groupDb.save).toHaveBeenCalledTimes(1);
    });

    it('recurrence — SET writes the inline config on a group with none', async () => {
      const group = seededGroup({ recurrenceConfig: null });
      const { service, groupDb } = arrangeUpdate(group);

      await service.update('user-1', 'group-1', {
        recurrence: { frequency: RecurrenceFrequency.DAILY },
      });

      expect(group.recurrenceConfig).toEqual(dailyConfig());
      expect(groupDb.save).toHaveBeenCalledTimes(1);
    });

    it('recurrence — CHANGE replaces an existing inline config', async () => {
      const group = seededGroup({ recurrenceConfig: dailyConfig() });
      const { service, groupDb } = arrangeUpdate(group);

      await service.update('user-1', 'group-1', {
        recurrence: { frequency: RecurrenceFrequency.WEEKLY, interval: 2 },
      });

      expect(group.recurrenceConfig).toEqual({
        frequency: RecurrenceFrequency.WEEKLY,
        interval: 2,
        byWeekday: null,
        byMonthDay: null,
        byMonth: null,
        bySetPos: null,
        monthlyAnchor: null,
        endType: RecurrenceEndType.NEVER,
        endDate: null,
        count: null,
      });
      expect(groupDb.save).toHaveBeenCalledTimes(1);
    });

    it('recurrence — CLEAR removes an existing inline config', async () => {
      const group = seededGroup({ recurrenceConfig: dailyConfig() });
      const { service, groupDb } = arrangeUpdate(group);

      await service.update('user-1', 'group-1', { recurrence: null });

      expect(group.recurrenceConfig).toBeNull();
      expect(groupDb.save).toHaveBeenCalledTimes(1);
    });

    it('no-op — short-circuits without saving when every field matches', async () => {
      const group = seededGroup({
        name: 'Stable',
        color: TaskColor.GREEN,
        icon: 'flag.fill',
        sortOrder: 3,
        requiresCompletion: false,
        recurrenceConfig: dailyConfig(),
      });
      const { service, groupDb } = arrangeUpdate(group);

      const result = await service.update('user-1', 'group-1', {
        name: 'Stable',
        color: TaskColor.GREEN,
        icon: 'flag.fill',
        sortOrder: 3,
        requiresCompletion: false,
      });

      expect(groupDb.save).not.toHaveBeenCalled();
      expect(result).toBe(group);
    });
  });
});
