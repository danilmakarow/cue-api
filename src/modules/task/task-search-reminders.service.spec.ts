import { ILike } from 'typeorm';

// `@Transactional()` (used by `create` / `update`) requires a registered
// transactional data source at runtime, which a pure unit spec has no DB to
// provide. Stub the decorator to a pass-through so the methods' logic can be
// exercised directly; the real transaction wrapping is covered at integration.
jest.mock('typeorm-transactional', () => ({
  Transactional: () => () => undefined,
}));

import { TaskService } from './task.service';
import { NotificationChannel, Task } from '@/modules/database/entities';

/**
 * Builds a Task fixture with the fields the search / reminder paths read.
 */
const makeTask = (overrides: Partial<Task> = {}): Task =>
  ({
    id: 'task-1',
    calendarId: 'cal-1',
    groupId: null,
    group: null,
    title: 'Task',
    notes: null,
    startAt: null,
    endAt: null,
    isAllDay: false,
    timezone: 'America/New_York',
    requiresCompletion: null,
    color: null,
    icon: null,
    completedAt: null,
    notificationStrategyId: null,
    recurrenceConfig: null,
    deletedAt: null,
    ...overrides,
  }) as Task;

/**
 * Builds a calendar-database stub owning `cal-1` (+ optionally `cal-2`).
 */
const buildCalendarDatabaseService = (calendarIds = ['cal-1']) => ({
  findOneBy: jest.fn().mockResolvedValue({ id: 'cal-1', ownerId: 'user-1' }),
  findAllByOwner: jest
    .fn()
    .mockResolvedValue(calendarIds.map((id) => ({ id, ownerId: 'user-1' }))),
});

/**
 * Builds a notification-rule service stub recording its calls.
 */
const buildNotificationRuleService = () => ({
  listByTask: jest.fn().mockResolvedValue([]),
  createForTask: jest.fn().mockResolvedValue([]),
  replaceForTask: jest.fn().mockResolvedValue([]),
});

/**
 * Wires a TaskService over the supplied task-db + notification-rule stubs.
 */
const buildService = (
  taskDb: Record<string, jest.Mock>,
  notificationRuleService = buildNotificationRuleService(),
  calendarDb = buildCalendarDatabaseService(),
) => {
  const service = new TaskService(
    taskDb as never,
    calendarDb as never,
    { findOneBy: jest.fn().mockResolvedValue(null) } as never,
    {} as never,
    {} as never,
    notificationRuleService as never,
  );

  return { service, taskDb, notificationRuleService, calendarDb };
};

describe('TaskService.searchTasks (M1)', () => {
  it('returns no matches and issues no query for a blank term', async () => {
    const taskDb = { findAll: jest.fn() };
    const { service } = buildService(taskDb);

    const result = await service.searchTasks('user-1', '   ');

    expect(result).toEqual([]);
    expect(taskDb.findAll).not.toHaveBeenCalled();
  });

  it('ILIKEs title + notes scoped to the user calendars, group relation loaded', async () => {
    const hit = makeTask({ id: 't-hit', title: 'Dentist' });
    const taskDb = { findAll: jest.fn().mockResolvedValue([hit]) };
    const { service } = buildService(taskDb);

    const result = await service.searchTasks('user-1', 'dent');

    expect(result).toEqual([hit]);

    const options = taskDb.findAll.mock.calls[0][0];

    // OR over title + notes, both calendar-scoped, group relation hydrated.
    expect(Array.isArray(options.where)).toBe(true);
    expect(options.where).toHaveLength(2);
    expect(options.relations).toEqual({ group: true });
    expect(options.where[0].title).toEqual(ILike('%dent%'));
    expect(options.where[1].notes).toEqual(ILike('%dent%'));
    expect(options.where[0].calendarId).toBeDefined();
    expect(options.where[1].calendarId).toBeDefined();
  });

  it('escapes ILIKE wildcards in the term', async () => {
    const taskDb = { findAll: jest.fn().mockResolvedValue([]) };
    const { service } = buildService(taskDb);

    await service.searchTasks('user-1', '50%_off');

    const options = taskDb.findAll.mock.calls[0][0];

    expect(options.where[0].title).toEqual(ILike('%50\\%\\_off%'));
  });

  it('narrows by groupId and clamps the limit to the max', async () => {
    const taskDb = { findAll: jest.fn().mockResolvedValue([]) };
    const { service } = buildService(taskDb);

    await service.searchTasks('user-1', 'x', { groupId: 'grp-1', limit: 999 });

    const options = taskDb.findAll.mock.calls[0][0];

    expect(options.where[0].groupId).toBe('grp-1');
    expect(options.where[1].groupId).toBe('grp-1');
    expect(options.take).toBe(50);
  });

  it('defaults the limit when none is given', async () => {
    const taskDb = { findAll: jest.fn().mockResolvedValue([]) };
    const { service } = buildService(taskDb);

    await service.searchTasks('user-1', 'x');

    expect(taskDb.findAll.mock.calls[0][0].take).toBe(25);
  });
});

describe('TaskService per-task reminders (S1)', () => {
  it('create persists reminders for the new task', async () => {
    const saved = makeTask({ id: 't-new' });
    const taskDb = {
      createInstance: jest.fn().mockReturnValue(saved),
      save: jest.fn().mockResolvedValue(saved),
    };
    const notificationRuleService = buildNotificationRuleService();
    const { service } = buildService(taskDb, notificationRuleService);

    await service.create('user-1', {
      calendarId: 'cal-1',
      title: 'Call',
      timezone: 'America/New_York',
      reminders: [
        { offsetMinutes: -15, channel: NotificationChannel.PUSH },
        { offsetMinutes: -60, channel: NotificationChannel.TELEGRAM },
      ],
    } as never);

    expect(notificationRuleService.createForTask).toHaveBeenCalledWith(
      't-new',
      [
        { offsetMinutes: -15, channel: NotificationChannel.PUSH },
        { offsetMinutes: -60, channel: NotificationChannel.TELEGRAM },
      ],
    );
    // Task row carries the new icon column (null when omitted).
    expect(taskDb.createInstance.mock.calls[0][0].icon).toBeNull();
  });

  it('create with no reminders issues no reminder write', async () => {
    const saved = makeTask({ id: 't-new' });
    const taskDb = {
      createInstance: jest.fn().mockReturnValue(saved),
      save: jest.fn().mockResolvedValue(saved),
    };
    const notificationRuleService = buildNotificationRuleService();
    const { service } = buildService(taskDb, notificationRuleService);

    await service.create('user-1', {
      calendarId: 'cal-1',
      title: 'Call',
      timezone: 'America/New_York',
    } as never);

    expect(notificationRuleService.createForTask).not.toHaveBeenCalled();
  });

  it('update replaces the reminder set when reminders is provided', async () => {
    const existing = makeTask({ id: 't-1', title: 'Call' });
    const taskDb = {
      findOneBy: jest.fn().mockResolvedValue(existing),
      save: jest.fn().mockImplementation((task: Task) => Promise.resolve(task)),
    };
    const notificationRuleService = buildNotificationRuleService();
    const { service } = buildService(taskDb, notificationRuleService);

    await service.update('user-1', 't-1', {
      reminders: [{ offsetMinutes: -10, channel: NotificationChannel.PUSH }],
    });

    expect(notificationRuleService.replaceForTask).toHaveBeenCalledWith('t-1', [
      { offsetMinutes: -10, channel: NotificationChannel.PUSH },
    ]);
  });

  it('update without reminders leaves the reminder set untouched', async () => {
    const existing = makeTask({ id: 't-1', title: 'Call' });
    const taskDb = {
      findOneBy: jest.fn().mockResolvedValue(existing),
      save: jest.fn().mockImplementation((task: Task) => Promise.resolve(task)),
    };
    const notificationRuleService = buildNotificationRuleService();
    const { service } = buildService(taskDb, notificationRuleService);

    await service.update('user-1', 't-1', { title: 'Call back' });

    expect(notificationRuleService.replaceForTask).not.toHaveBeenCalled();
  });

  it('update persists the icon (set + clear)', async () => {
    const existing = makeTask({ id: 't-1', icon: 'old.icon' });
    const taskDb = {
      findOneBy: jest.fn().mockResolvedValue(existing),
      save: jest.fn().mockImplementation((task: Task) => Promise.resolve(task)),
    };
    const { service } = buildService(taskDb);

    const updated = await service.update('user-1', 't-1', {
      icon: 'cart.fill',
    });

    expect(updated.icon).toBe('cart.fill');

    const cleared = await service.update('user-1', 't-1', { icon: null });

    expect(cleared.icon).toBeNull();
  });

  it('listReminders asserts ownership then delegates to the rule service', async () => {
    const existing = makeTask({ id: 't-1' });
    const taskDb = {
      findOneBy: jest.fn().mockResolvedValue(existing),
    };
    const notificationRuleService = buildNotificationRuleService();
    const { service } = buildService(taskDb, notificationRuleService);

    await service.listReminders('user-1', 't-1');

    expect(taskDb.findOneBy).toHaveBeenCalledWith({ id: 't-1' });
    expect(notificationRuleService.listByTask).toHaveBeenCalledWith('t-1');
  });
});
