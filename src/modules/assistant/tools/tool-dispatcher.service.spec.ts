import { BadRequestException } from '@nestjs/common';

import { ToolDispatchContext } from '../assistant.types';
import { formatTaskLine } from '../event-formatting';
import { ScheduleReaderService } from '../schedule-reader.service';
import { HandleMap } from './handle-map';
import { ToolDispatcherService } from './tool-dispatcher.service';
import { ToolCall } from '@/modules/ai/ai.types';
import { CalendarService } from '@/modules/calendar/calendar.service';
import { Task, TaskGroup, User } from '@/modules/database/entities';
import { Occurrence } from '@/modules/recurrence-rule/recurrence.types';
import { TaskService } from '@/modules/task/task.service';
import { TaskGroupService } from '@/modules/task-group/task-group.service';

/**
 * Builds a dispatch context with a fixed user/timezone and a fresh handle map.
 */
const buildContext = (handleMap = new HandleMap()): ToolDispatchContext => ({
  userId: 'user-1',
  user: { id: 'user-1', timezone: 'UTC' } as User,
  handleMap,
});

/**
 * Builds a minimal `Occurrence` for tests, defaulting to a one-off timed event.
 */
const buildOccurrence = (overrides: Partial<Occurrence> = {}): Occurrence => ({
  task: { id: 'task-1', isAllDay: false } as Task,
  originalStart: new Date('2026-06-02T09:00:00.000Z'),
  occurrenceStart: new Date('2026-06-02T09:00:00.000Z'),
  occurrenceEnd: new Date('2026-06-02T09:30:00.000Z'),
  title: 'Standup',
  completedAt: null,
  isRecurring: false,
  isException: false,
  ...overrides,
});

/**
 * Assembles a `ToolDispatcherService` with mocked feature services.
 */
const buildDispatcher = () => {
  const taskService = {
    create: jest.fn().mockResolvedValue({ id: 'task-1', title: 'Dentist' }),
    update: jest.fn().mockResolvedValue({ id: 'task-1', title: 'Lunch' }),
    remove: jest.fn().mockResolvedValue(undefined),
    findById: jest.fn().mockResolvedValue({
      id: 'task-1',
      recurrenceRuleId: null,
      calendarId: 'cal-1',
    }),
    findOverlapping: jest.fn().mockResolvedValue([]),
    setCompleted: jest.fn().mockResolvedValue(undefined),
    setOccurrenceCompleted: jest.fn().mockResolvedValue(undefined),
    applyOccurrenceOverride: jest.fn().mockResolvedValue(undefined),
    splitSeries: jest
      .fn()
      .mockResolvedValue({ id: 'task-2', title: 'Standup' }),
    endSeriesAt: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<TaskService>;
  const taskGroupService = {
    findByName: jest.fn().mockResolvedValue([{ id: 'grp-1', name: 'Work' }]),
    findAllForUser: jest.fn().mockResolvedValue([]),
    create: jest.fn().mockResolvedValue({ id: 'grp-9', name: 'Home reno' }),
  } as unknown as jest.Mocked<TaskGroupService>;
  const calendarService = {
    findPrimaryForOwner: jest.fn().mockResolvedValue({ id: 'cal-1' }),
    findAllByOwner: jest.fn().mockResolvedValue([{ id: 'cal-1' }]),
  } as unknown as jest.Mocked<CalendarService>;
  const scheduleReader = {
    occurrencesInRange: jest.fn().mockResolvedValue([]),
  } as unknown as jest.Mocked<ScheduleReaderService>;

  const dispatcher = new ToolDispatcherService(
    taskService,
    taskGroupService,
    calendarService,
    scheduleReader,
  );

  return {
    dispatcher,
    taskService,
    taskGroupService,
    calendarService,
    scheduleReader,
  };
};

/** Builds a tool call with the given name + input. */
const toolCall = (name: string, input: Record<string, unknown>): ToolCall => ({
  id: 'tc-1',
  name,
  input,
});

describe('HandleMap', () => {
  it('mints sequential aliases and resolves them to their targets', () => {
    const map = new HandleMap();

    const first = map.add({ taskId: 'a', originalStart: null });
    const second = map.add({ taskId: 'b', originalStart: new Date(0) });

    expect(first).toBe('e1');
    expect(second).toBe('e2');
    expect(map.resolve('e1')).toEqual({ taskId: 'a', originalStart: null });
    expect(map.resolve('e2')?.taskId).toBe('b');
    expect(map.resolve('e9')).toBeUndefined();
  });

  it('maps a recurring occurrence to (taskId, originalStart) and a one-off to null', () => {
    const map = new HandleMap();
    const recurring = buildOccurrence({
      task: { id: 'rec-1', isAllDay: false } as Task,
      originalStart: new Date('2026-06-03T09:00:00.000Z'),
      isRecurring: true,
    });
    const oneOff = buildOccurrence({
      task: { id: 'one-1', isAllDay: false } as Task,
      originalStart: null,
    });

    const recAlias = map.addOccurrence(recurring);
    const oneAlias = map.addOccurrence(oneOff);

    expect(map.resolve(recAlias)).toEqual({
      taskId: 'rec-1',
      originalStart: new Date('2026-06-03T09:00:00.000Z'),
    });
    expect(map.resolve(oneAlias)).toEqual({
      taskId: 'one-1',
      originalStart: null,
    });
  });
});

describe('formatTaskLine', () => {
  it('renders a timed occurrence with its handle', () => {
    const line = formatTaskLine(buildOccurrence(), 'UTC', 'e2');

    expect(line).toBe('[e2] Tue 02 Jun 09:00–09:30 Standup');
  });

  it('renders an all-day occurrence', () => {
    const line = formatTaskLine(
      buildOccurrence({
        task: { id: 'task-1', isAllDay: true } as Task,
        occurrenceEnd: null,
        title: 'Holiday',
      }),
      'UTC',
      'e1',
    );

    expect(line).toBe('[e1] Tue 02 Jun all-day Holiday');
  });

  it('renders a timeless todo with no time', () => {
    const line = formatTaskLine(
      buildOccurrence({
        originalStart: null,
        occurrenceStart: null,
        occurrenceEnd: null,
        title: 'Stretch',
      }),
      'UTC',
      'e3',
    );

    expect(line).toBe('[e3] todo: Stretch');
  });
});

describe('ToolDispatcherService', () => {
  describe('list_tasks', () => {
    it('seeds the handle map, renders aliased lines, and counts as a fetch', async () => {
      const harness = buildDispatcher();
      const handleMap = new HandleMap();

      (
        harness.scheduleReader.occurrencesInRange as jest.Mock
      ).mockResolvedValue([
        buildOccurrence({ task: { id: 'a', isAllDay: false } as Task }),
        buildOccurrence({
          task: { id: 'b', isAllDay: false } as Task,
          originalStart: new Date('2026-06-02T14:00:00.000Z'),
          occurrenceStart: new Date('2026-06-02T14:00:00.000Z'),
          occurrenceEnd: new Date('2026-06-02T15:00:00.000Z'),
          title: 'Dentist',
          isRecurring: true,
        }),
      ]);

      const outcome = await harness.dispatcher.dispatch(
        toolCall('list_tasks', {
          from: '2026-06-02T00:00:00.000Z',
          to: '2026-06-03T00:00:00.000Z',
        }),
        buildContext(handleMap),
      );

      expect(outcome.countsAsScheduleFetch).toBe(true);
      expect(outcome.content).toContain('[e1]');
      expect(outcome.content).toContain('[e2] Tue 02 Jun 14:00–15:00 Dentist');
      expect(handleMap.resolve('e2')).toEqual({
        taskId: 'b',
        originalStart: new Date('2026-06-02T14:00:00.000Z'),
      });
    });

    it('keeps counting aliases up across two list_tasks calls in one turn', async () => {
      const harness = buildDispatcher();
      const handleMap = new HandleMap();
      const context = buildContext(handleMap);

      (
        harness.scheduleReader.occurrencesInRange as jest.Mock
      ).mockResolvedValue([
        buildOccurrence({ task: { id: 'a', isAllDay: false } as Task }),
      ]);

      await harness.dispatcher.dispatch(toolCall('list_tasks', {}), context);

      const second = await harness.dispatcher.dispatch(
        toolCall('list_tasks', {}),
        context,
      );

      expect(second.content).toContain('[e2]');
      expect(handleMap.resolve('e1')?.taskId).toBe('a');
      expect(handleMap.resolve('e2')?.taskId).toBe('a');
    });

    it('resolves a group name to a groupId filter', async () => {
      const harness = buildDispatcher();

      await harness.dispatcher.dispatch(
        toolCall('list_tasks', { group: 'Work' }),
        buildContext(),
      );

      expect(harness.taskGroupService.findByName).toHaveBeenCalledWith(
        'user-1',
        'Work',
      );
      expect(
        (harness.scheduleReader.occurrencesInRange as jest.Mock).mock
          .calls[0][3],
      ).toMatchObject({ groupId: 'grp-1' });
    });
  });

  describe('create_task', () => {
    it('creates a timed task when there is no conflict', async () => {
      const harness = buildDispatcher();

      const outcome = await harness.dispatcher.dispatch(
        toolCall('create_task', {
          title: 'Dentist',
          startAt: '2026-06-10T15:00:00.000Z',
          endAt: '2026-06-10T16:00:00.000Z',
        }),
        buildContext(),
      );

      expect(harness.taskService.create).toHaveBeenCalledTimes(1);
      expect(outcome.heldConflict).toBeUndefined();
      expect(outcome.content).toMatch(/created/i);
    });

    it('creates a timeless todo (no startAt)', async () => {
      const harness = buildDispatcher();

      await harness.dispatcher.dispatch(
        toolCall('create_task', { title: 'Stretch' }),
        buildContext(),
      );

      const arg = (harness.taskService.create as jest.Mock).mock.calls[0][1];

      expect(arg.startAt).toBeUndefined();
      expect(harness.taskService.findOverlapping).not.toHaveBeenCalled();
    });

    it('passes recurrence through and skips the overlap hold', async () => {
      const harness = buildDispatcher();

      const outcome = await harness.dispatcher.dispatch(
        toolCall('create_task', {
          title: 'Standup',
          startAt: '2026-06-10T09:00:00.000Z',
          endAt: '2026-06-10T09:15:00.000Z',
          recurrence: { frequency: 'WEEKLY', byWeekday: [0, 1, 2, 3, 4] },
        }),
        buildContext(),
      );

      const arg = (harness.taskService.create as jest.Mock).mock.calls[0][1];

      expect(arg.recurrence).toMatchObject({
        frequency: 'WEEKLY',
        byWeekday: [0, 1, 2, 3, 4],
      });
      expect(harness.taskService.findOverlapping).not.toHaveBeenCalled();
      expect(outcome.heldConflict).toBeUndefined();
    });

    it('rejects a COUNT recurrence missing count with a recoverable error (no write)', async () => {
      const harness = buildDispatcher();

      const outcome = await harness.dispatcher.dispatch(
        toolCall('create_task', {
          title: 'Standup',
          startAt: '2026-06-10T09:00:00.000Z',
          endAt: '2026-06-10T09:15:00.000Z',
          recurrence: { frequency: 'WEEKLY', endType: 'COUNT' },
        }),
        buildContext(),
      );

      expect(outcome.isError).toBe(true);
      expect(outcome.content).toMatch(/count is required/i);
      expect(harness.taskService.create).not.toHaveBeenCalled();
    });

    it('rejects an UNTIL_DATE recurrence missing endDate with a recoverable error (no write)', async () => {
      const harness = buildDispatcher();

      const outcome = await harness.dispatcher.dispatch(
        toolCall('create_task', {
          title: 'Standup',
          startAt: '2026-06-10T09:00:00.000Z',
          endAt: '2026-06-10T09:15:00.000Z',
          recurrence: { frequency: 'WEEKLY', endType: 'UNTIL_DATE' },
        }),
        buildContext(),
      );

      expect(outcome.isError).toBe(true);
      expect(outcome.content).toMatch(/endDate is required/i);
      expect(harness.taskService.create).not.toHaveBeenCalled();
    });

    it('accepts a COUNT recurrence that supplies a positive count', async () => {
      const harness = buildDispatcher();

      const outcome = await harness.dispatcher.dispatch(
        toolCall('create_task', {
          title: 'Standup',
          startAt: '2026-06-10T09:00:00.000Z',
          endAt: '2026-06-10T09:15:00.000Z',
          recurrence: { frequency: 'WEEKLY', endType: 'COUNT', count: 12 },
        }),
        buildContext(),
      );

      const arg = (harness.taskService.create as jest.Mock).mock.calls[0][1];

      expect(arg.recurrence).toMatchObject({ endType: 'COUNT', count: 12 });
      expect(outcome.isError).toBeUndefined();
    });

    it('resolves a group name to a groupId on create', async () => {
      const harness = buildDispatcher();

      await harness.dispatcher.dispatch(
        toolCall('create_task', { title: 'Paint', group: 'Work' }),
        buildContext(),
      );

      const arg = (harness.taskService.create as jest.Mock).mock.calls[0][1];

      expect(arg.groupId).toBe('grp-1');
    });

    it('returns a recoverable result for an ambiguous group name (no write)', async () => {
      const harness = buildDispatcher();

      (harness.taskGroupService.findByName as jest.Mock).mockResolvedValue([
        { id: 'grp-1', name: 'Work' } as TaskGroup,
        { id: 'grp-2', name: 'Work' } as TaskGroup,
      ]);

      const outcome = await harness.dispatcher.dispatch(
        toolCall('create_task', { title: 'Paint', group: 'Work' }),
        buildContext(),
      );

      expect(outcome.isError).toBe(true);
      expect(outcome.content).toMatch(/which one/i);
      expect(harness.taskService.create).not.toHaveBeenCalled();
    });

    it('returns a recoverable result for a missing group name (no write)', async () => {
      const harness = buildDispatcher();

      (harness.taskGroupService.findByName as jest.Mock).mockResolvedValue([]);

      const outcome = await harness.dispatcher.dispatch(
        toolCall('create_task', { title: 'Paint', group: 'Ghost' }),
        buildContext(),
      );

      expect(outcome.isError).toBe(true);
      expect(outcome.content).toMatch(/no group named/i);
      expect(harness.taskService.create).not.toHaveBeenCalled();
    });

    it('holds a create_task that overlaps an existing task instead of writing', async () => {
      const harness = buildDispatcher();

      (harness.taskService.findOverlapping as jest.Mock).mockResolvedValue([
        { id: 'other', title: 'Lunch with Ana' } as Task,
      ]);

      const outcome = await harness.dispatcher.dispatch(
        toolCall('create_task', {
          title: 'Dentist',
          startAt: '2026-06-10T13:30:00.000Z',
          endAt: '2026-06-10T14:30:00.000Z',
        }),
        buildContext(),
      );

      expect(harness.taskService.create).not.toHaveBeenCalled();
      expect(outcome.heldConflict).toBeDefined();
      expect(outcome.heldConflict?.promptText).toMatch(/Lunch with Ana/);
      expect(outcome.heldConflict?.write.action.kind).toBe('create_event');
    });
  });

  describe('update_task', () => {
    it('updates a one-off task by handle (ignores editScope)', async () => {
      const harness = buildDispatcher();
      const handleMap = new HandleMap();
      const alias = handleMap.add({ taskId: 'task-1', originalStart: null });

      const outcome = await harness.dispatcher.dispatch(
        toolCall('update_task', { handle: alias, title: 'Lunch' }),
        buildContext(handleMap),
      );

      expect(harness.taskService.update).toHaveBeenCalledTimes(1);
      expect(outcome.content).toMatch(/updated/i);
    });

    it('returns a stale-handle error when the handle is unknown', async () => {
      const harness = buildDispatcher();

      const outcome = await harness.dispatcher.dispatch(
        toolCall('update_task', { handle: 'e9', title: 'X' }),
        buildContext(new HandleMap()),
      );

      expect(outcome.isError).toBe(true);
      expect(outcome.content).toMatch(/isn't in view/i);
      expect(harness.taskService.update).not.toHaveBeenCalled();
    });

    it('asks for a scope when a recurring task is updated without editScope', async () => {
      const harness = buildDispatcher();

      (harness.taskService.findById as jest.Mock).mockResolvedValue({
        id: 'task-1',
        recurrenceRuleId: 'rule-1',
        calendarId: 'cal-1',
      });

      const handleMap = new HandleMap();
      const alias = handleMap.add({
        taskId: 'task-1',
        originalStart: new Date('2026-06-03T09:00:00.000Z'),
      });

      const outcome = await harness.dispatcher.dispatch(
        toolCall('update_task', {
          handle: alias,
          startAt: '2026-06-03T10:00:00.000Z',
        }),
        buildContext(handleMap),
      );

      expect(outcome.isError).toBe(true);
      expect(outcome.content).toMatch(/repeating task/i);
      expect(
        harness.taskService.applyOccurrenceOverride,
      ).not.toHaveBeenCalled();
      expect(harness.taskService.splitSeries).not.toHaveBeenCalled();
      expect(harness.taskService.update).not.toHaveBeenCalled();
    });

    it('applies an occurrence override for editScope "this"', async () => {
      const harness = buildDispatcher();

      (harness.taskService.findById as jest.Mock).mockResolvedValue({
        id: 'task-1',
        recurrenceRuleId: 'rule-1',
        calendarId: 'cal-1',
      });

      const handleMap = new HandleMap();
      const alias = handleMap.add({
        taskId: 'task-1',
        originalStart: new Date('2026-06-03T09:00:00.000Z'),
      });

      await harness.dispatcher.dispatch(
        toolCall('update_task', {
          handle: alias,
          startAt: '2026-06-03T10:00:00.000Z',
          editScope: 'this',
        }),
        buildContext(handleMap),
      );

      expect(harness.taskService.applyOccurrenceOverride).toHaveBeenCalledWith(
        'user-1',
        'task-1',
        new Date('2026-06-03T09:00:00.000Z'),
        { overrideStartAt: new Date('2026-06-03T10:00:00.000Z') },
      );
    });

    it('splits the series for editScope "this_and_following"', async () => {
      const harness = buildDispatcher();

      (harness.taskService.findById as jest.Mock).mockResolvedValue({
        id: 'task-1',
        recurrenceRuleId: 'rule-1',
        calendarId: 'cal-1',
      });

      const handleMap = new HandleMap();
      const alias = handleMap.add({
        taskId: 'task-1',
        originalStart: new Date('2026-06-03T09:00:00.000Z'),
      });

      await harness.dispatcher.dispatch(
        toolCall('update_task', {
          handle: alias,
          title: 'New name',
          editScope: 'this_and_following',
        }),
        buildContext(handleMap),
      );

      expect(harness.taskService.splitSeries).toHaveBeenCalledWith(
        'user-1',
        'task-1',
        new Date('2026-06-03T09:00:00.000Z'),
        { title: 'New name' },
      );
    });

    it('passes a group change INTO splitSeries (atomic) for "this_and_following", no follow-up update', async () => {
      const harness = buildDispatcher();

      (harness.taskService.findById as jest.Mock).mockResolvedValue({
        id: 'task-1',
        recurrenceRuleId: 'rule-1',
        calendarId: 'cal-1',
      });
      (harness.taskService.splitSeries as jest.Mock).mockResolvedValue({
        id: 'task-2',
        title: 'Standup',
      });

      const handleMap = new HandleMap();
      const alias = handleMap.add({
        taskId: 'task-1',
        originalStart: new Date('2026-06-03T09:00:00.000Z'),
      });

      const outcome = await harness.dispatcher.dispatch(
        toolCall('update_task', {
          handle: alias,
          group: 'Work',
          editScope: 'this_and_following',
        }),
        buildContext(handleMap),
      );

      // Group resolved BEFORE the split, then carried into splitSeries so the
      // group is applied atomically — there is NO separate post-split update.
      expect(harness.taskGroupService.findByName).toHaveBeenCalledWith(
        'user-1',
        'Work',
      );
      expect(harness.taskService.splitSeries).toHaveBeenCalledWith(
        'user-1',
        'task-1',
        new Date('2026-06-03T09:00:00.000Z'),
        { groupId: 'grp-1' },
      );
      expect(harness.taskService.update).not.toHaveBeenCalled();
      expect(outcome.content).toMatch(/moved them to the group/i);
    });

    it('surfaces a cross-calendar group rejection from splitSeries as a recoverable error (no follow-up write)', async () => {
      const harness = buildDispatcher();

      (harness.taskService.findById as jest.Mock).mockResolvedValue({
        id: 'task-1',
        recurrenceRuleId: 'rule-1',
        calendarId: 'cal-1',
      });
      // resolveGroup finds the uniquely-named group (findByName spans every
      // calendar), so the dispatcher passes its id into splitSeries — which
      // rejects it as cross-calendar BEFORE writing. The series is NOT split.
      (harness.taskService.splitSeries as jest.Mock).mockRejectedValue(
        new BadRequestException(
          'group must belong to the same calendar as the task',
        ),
      );

      const handleMap = new HandleMap();
      const alias = handleMap.add({
        taskId: 'task-1',
        originalStart: new Date('2026-06-03T09:00:00.000Z'),
      });

      const outcome = await harness.dispatcher.dispatch(
        toolCall('update_task', {
          handle: alias,
          group: 'Work',
          editScope: 'this_and_following',
        }),
        buildContext(handleMap),
      );

      expect(harness.taskService.splitSeries).toHaveBeenCalledWith(
        'user-1',
        'task-1',
        new Date('2026-06-03T09:00:00.000Z'),
        { groupId: 'grp-1' },
      );
      expect(outcome.isError).toBe(true);
      expect(outcome.content).toMatch(/same calendar/i);
      // No partial second write — the split itself was the only call attempted.
      expect(harness.taskService.update).not.toHaveBeenCalled();
    });

    it('surfaces an ambiguous group for "this_and_following" BEFORE splitting (no split)', async () => {
      const harness = buildDispatcher();

      (harness.taskService.findById as jest.Mock).mockResolvedValue({
        id: 'task-1',
        recurrenceRuleId: 'rule-1',
        calendarId: 'cal-1',
      });
      (harness.taskGroupService.findByName as jest.Mock).mockResolvedValue([
        { id: 'grp-1', name: 'Work' } as TaskGroup,
        { id: 'grp-2', name: 'Work' } as TaskGroup,
      ]);

      const handleMap = new HandleMap();
      const alias = handleMap.add({
        taskId: 'task-1',
        originalStart: new Date('2026-06-03T09:00:00.000Z'),
      });

      const outcome = await harness.dispatcher.dispatch(
        toolCall('update_task', {
          handle: alias,
          group: 'Work',
          editScope: 'this_and_following',
        }),
        buildContext(handleMap),
      );

      expect(outcome.isError).toBe(true);
      expect(outcome.content).toMatch(/which one/i);
      expect(harness.taskService.splitSeries).not.toHaveBeenCalled();
      expect(harness.taskService.update).not.toHaveBeenCalled();
    });

    it('does not call update for grouping when "this_and_following" has no group', async () => {
      const harness = buildDispatcher();

      (harness.taskService.findById as jest.Mock).mockResolvedValue({
        id: 'task-1',
        recurrenceRuleId: 'rule-1',
        calendarId: 'cal-1',
      });

      const handleMap = new HandleMap();
      const alias = handleMap.add({
        taskId: 'task-1',
        originalStart: new Date('2026-06-03T09:00:00.000Z'),
      });

      await harness.dispatcher.dispatch(
        toolCall('update_task', {
          handle: alias,
          title: 'New name',
          editScope: 'this_and_following',
        }),
        buildContext(handleMap),
      );

      expect(harness.taskService.splitSeries).toHaveBeenCalledTimes(1);
      expect(harness.taskService.update).not.toHaveBeenCalled();
    });

    it('updates the master for editScope "all"', async () => {
      const harness = buildDispatcher();

      (harness.taskService.findById as jest.Mock).mockResolvedValue({
        id: 'task-1',
        recurrenceRuleId: 'rule-1',
        calendarId: 'cal-1',
      });

      const handleMap = new HandleMap();
      const alias = handleMap.add({
        taskId: 'task-1',
        originalStart: new Date('2026-06-03T09:00:00.000Z'),
      });

      await harness.dispatcher.dispatch(
        toolCall('update_task', {
          handle: alias,
          title: 'All renamed',
          editScope: 'all',
        }),
        buildContext(handleMap),
      );

      expect(harness.taskService.update).toHaveBeenCalledWith(
        'user-1',
        'task-1',
        {
          title: 'All renamed',
        },
      );
    });

    it('holds a one-off timed move that overlaps an existing task', async () => {
      const harness = buildDispatcher();

      (harness.taskService.findById as jest.Mock).mockResolvedValue({
        id: 'task-1',
        recurrenceRuleId: null,
        calendarId: 'cal-1',
        startAt: null,
        endAt: null,
      });
      (harness.taskService.findOverlapping as jest.Mock).mockResolvedValue([
        { id: 'other', title: 'Lunch' } as Task,
      ]);

      const handleMap = new HandleMap();
      const alias = handleMap.add({ taskId: 'task-1', originalStart: null });

      const outcome = await harness.dispatcher.dispatch(
        toolCall('update_task', {
          handle: alias,
          startAt: '2026-06-10T13:00:00.000Z',
          endAt: '2026-06-10T14:00:00.000Z',
        }),
        buildContext(handleMap),
      );

      expect(outcome.heldConflict).toBeDefined();
      expect(outcome.heldConflict?.write.action.kind).toBe('update_event');
      expect(harness.taskService.update).not.toHaveBeenCalled();
    });
  });

  describe('complete_task', () => {
    it('completes a one-off via setCompleted', async () => {
      const harness = buildDispatcher();
      const handleMap = new HandleMap();
      const alias = handleMap.add({ taskId: 'task-1', originalStart: null });

      const outcome = await harness.dispatcher.dispatch(
        toolCall('complete_task', { handle: alias }),
        buildContext(handleMap),
      );

      expect(harness.taskService.setCompleted).toHaveBeenCalledWith(
        'task-1',
        true,
      );
      expect(outcome.content).toMatch(/complete/i);
    });

    it('completes a recurring occurrence via setOccurrenceCompleted', async () => {
      const harness = buildDispatcher();

      (harness.taskService.findById as jest.Mock).mockResolvedValue({
        id: 'task-1',
        recurrenceRuleId: 'rule-1',
        calendarId: 'cal-1',
      });

      const handleMap = new HandleMap();
      const alias = handleMap.add({
        taskId: 'task-1',
        originalStart: new Date('2026-06-03T09:00:00.000Z'),
      });

      await harness.dispatcher.dispatch(
        toolCall('complete_task', { handle: alias, completed: false }),
        buildContext(handleMap),
      );

      expect(harness.taskService.setOccurrenceCompleted).toHaveBeenCalledWith(
        'user-1',
        'task-1',
        new Date('2026-06-03T09:00:00.000Z'),
        false,
      );
      expect(harness.taskService.setCompleted).not.toHaveBeenCalled();
    });
  });

  describe('delete_task', () => {
    it('skips a single recurring occurrence for editScope "this"', async () => {
      const harness = buildDispatcher();

      (harness.taskService.findById as jest.Mock).mockResolvedValue({
        id: 'task-1',
        recurrenceRuleId: 'rule-1',
        calendarId: 'cal-1',
      });

      const handleMap = new HandleMap();
      const alias = handleMap.add({
        taskId: 'task-1',
        originalStart: new Date('2026-06-03T09:00:00.000Z'),
      });

      const outcome = await harness.dispatcher.dispatch(
        toolCall('delete_task', { handle: alias, editScope: 'this' }),
        buildContext(handleMap),
      );

      expect(harness.taskService.applyOccurrenceOverride).toHaveBeenCalledWith(
        'user-1',
        'task-1',
        new Date('2026-06-03T09:00:00.000Z'),
        { isSkipped: true },
      );
      expect(harness.taskService.remove).not.toHaveBeenCalled();
      expect(outcome.content).toMatch(/occurrence/i);
    });

    it('asks for a scope when a recurring task is deleted without editScope', async () => {
      const harness = buildDispatcher();

      (harness.taskService.findById as jest.Mock).mockResolvedValue({
        id: 'task-1',
        recurrenceRuleId: 'rule-1',
        calendarId: 'cal-1',
      });

      const handleMap = new HandleMap();
      const alias = handleMap.add({
        taskId: 'task-1',
        originalStart: new Date('2026-06-03T09:00:00.000Z'),
      });

      const outcome = await harness.dispatcher.dispatch(
        toolCall('delete_task', { handle: alias }),
        buildContext(handleMap),
      );

      expect(outcome.isError).toBe(true);
      expect(outcome.content).toMatch(/repeating task/i);
      expect(harness.taskService.remove).not.toHaveBeenCalled();
    });

    it('truncates the series for editScope "this_and_following" (not a whole-series delete)', async () => {
      const harness = buildDispatcher();

      (harness.taskService.findById as jest.Mock).mockResolvedValue({
        id: 'task-1',
        recurrenceRuleId: 'rule-1',
        calendarId: 'cal-1',
      });

      const handleMap = new HandleMap();
      const alias = handleMap.add({
        taskId: 'task-1',
        originalStart: new Date('2026-06-03T09:00:00.000Z'),
      });

      const outcome = await harness.dispatcher.dispatch(
        toolCall('delete_task', {
          handle: alias,
          editScope: 'this_and_following',
        }),
        buildContext(handleMap),
      );

      // Truncation ends the rule at the occurrence — past occurrences survive,
      // so this must NOT be a whole-series remove().
      expect(harness.taskService.endSeriesAt).toHaveBeenCalledWith(
        'user-1',
        'task-1',
        new Date('2026-06-03T09:00:00.000Z'),
      );
      expect(harness.taskService.remove).not.toHaveBeenCalled();
      expect(
        harness.taskService.applyOccurrenceOverride,
      ).not.toHaveBeenCalled();
      expect(outcome.content).toMatch(/following/i);
    });

    it('removes a one-off task', async () => {
      const harness = buildDispatcher();
      const handleMap = new HandleMap();
      const alias = handleMap.add({ taskId: 'task-1', originalStart: null });

      const outcome = await harness.dispatcher.dispatch(
        toolCall('delete_task', { handle: alias }),
        buildContext(handleMap),
      );

      expect(harness.taskService.remove).toHaveBeenCalledWith(
        'user-1',
        'task-1',
      );
      expect(outcome.content).toMatch(/deleted/i);
    });
  });

  describe('groups', () => {
    it('lists group names', async () => {
      const harness = buildDispatcher();

      (harness.taskGroupService.findAllForUser as jest.Mock).mockResolvedValue([
        { id: 'g1', name: 'Work' } as TaskGroup,
        { id: 'g2', name: 'Home' } as TaskGroup,
      ]);

      const outcome = await harness.dispatcher.dispatch(
        toolCall('list_groups', {}),
        buildContext(),
      );

      expect(outcome.content).toBe('Work, Home');
    });

    it('creates a group in the primary calendar', async () => {
      const harness = buildDispatcher();

      const outcome = await harness.dispatcher.dispatch(
        toolCall('create_group', { name: 'Home reno' }),
        buildContext(),
      );

      expect(harness.taskGroupService.create).toHaveBeenCalledWith('user-1', {
        calendarId: 'cal-1',
        name: 'Home reno',
        color: undefined,
        icon: undefined,
      });
      expect(outcome.content).toMatch(/created group/i);
    });
  });

  describe('misc', () => {
    it('returns an error outcome (not a throw) on invalid tool input', async () => {
      const harness = buildDispatcher();

      const outcome = await harness.dispatcher.dispatch(
        toolCall('create_task', { startAt: '2026-06-10T15:00:00.000Z' }),
        buildContext(),
      );

      expect(outcome.isError).toBe(true);
      expect(harness.taskService.create).not.toHaveBeenCalled();
    });

    it('returns a graceful result for set_reminder (not yet wired)', async () => {
      const harness = buildDispatcher();
      const handleMap = new HandleMap();
      const alias = handleMap.add({ taskId: 'task-1', originalStart: null });

      const outcome = await harness.dispatcher.dispatch(
        toolCall('set_reminder', { handle: alias, offsetMinutes: -15 }),
        buildContext(handleMap),
      );

      expect(outcome.isError).toBeUndefined();
      expect(outcome.content).toMatch(/not available yet/i);
    });

    it('returns an error outcome for an unknown tool', async () => {
      const harness = buildDispatcher();

      const outcome = await harness.dispatcher.dispatch(
        toolCall('teleport', {}),
        buildContext(),
      );

      expect(outcome.isError).toBe(true);
      expect(outcome.content).toMatch(/unknown tool/i);
    });
  });
});
