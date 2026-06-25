import { BadRequestException } from '@nestjs/common';

import { ToolDispatchContext } from '../assistant.types';
import { formatTaskLine } from '../event-formatting';
import { ScheduleReaderService } from '../schedule-reader.service';
import { HandleMap } from './handle-map';
import { ToolDispatcherService } from './tool-dispatcher.service';
import { ToolCall } from '@/modules/ai/ai.types';
import { CalendarService } from '@/modules/calendar/calendar.service';
import {
  ConflictPolicy,
  Task,
  TaskGroup,
  User,
} from '@/modules/database/entities';
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
 * Builds a dispatch context carrying a STANDING `conflict_policy` (Story 15 / ADR
 * 0011 + 0044), to exercise the allow/deny override of the overlap gate.
 */
const buildContextWithPolicy = (
  conflictPolicy: ConflictPolicy,
  handleMap = new HandleMap(),
): ToolDispatchContext => ({
  ...buildContext(handleMap),
  conflictPolicy,
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
      recurrenceConfig: null,
      calendarId: 'cal-1',
    }),
    findOverlapping: jest.fn().mockResolvedValue([]),
    findRecurringSeriesConflicts: jest
      .fn()
      .mockResolvedValue({ conflictDates: [], conflictingTasks: [] }),
    findRecurringEditConflicts: jest
      .fn()
      .mockResolvedValue({ conflictDates: [], conflictingTasks: [] }),
    setCompleted: jest.fn().mockResolvedValue(undefined),
    setOccurrenceCompleted: jest.fn().mockResolvedValue(undefined),
    findOccurrenceException: jest.fn().mockResolvedValue(null),
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
    update: jest.fn().mockResolvedValue({ id: 'grp-1', name: 'Work' }),
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

    it('caps a long agenda at the line limit and appends a "+N more" hint', async () => {
      const harness = buildDispatcher();
      const handleMap = new HandleMap();
      // 45 occurrences → 40 rendered + a single overflow hint line (5 hidden).
      const occurrences = Array.from({ length: 45 }, (_unused, index) =>
        buildOccurrence({
          task: { id: `t-${index}`, isAllDay: false } as Task,
          title: `Task ${index}`,
        }),
      );

      (
        harness.scheduleReader.occurrencesInRange as jest.Mock
      ).mockResolvedValue(occurrences);

      const outcome = await harness.dispatcher.dispatch(
        toolCall('list_tasks', {}),
        buildContext(handleMap),
      );

      const lines = outcome.content.split('\n');

      // 40 task lines + 1 overflow line.
      expect(lines).toHaveLength(41);
      expect(lines[40]).toBe('(+5 more — narrow the range or filter by group)');
      expect(outcome.countsAsScheduleFetch).toBe(true);
      // Handles are minted ONLY for the 40 shown lines — the 41st is not seeded.
      expect(handleMap.resolve('e40')?.taskId).toBe('t-39');
      expect(handleMap.resolve('e41')).toBeUndefined();
    });

    it('does not append a "+N more" hint when the agenda fits the line limit', async () => {
      const harness = buildDispatcher();
      const occurrences = Array.from({ length: 40 }, (_unused, index) =>
        buildOccurrence({
          task: { id: `t-${index}`, isAllDay: false } as Task,
          title: `Task ${index}`,
        }),
      );

      (
        harness.scheduleReader.occurrencesInRange as jest.Mock
      ).mockResolvedValue(occurrences);

      const outcome = await harness.dispatcher.dispatch(
        toolCall('list_tasks', {}),
        buildContext(new HandleMap()),
      );

      const lines = outcome.content.split('\n');

      expect(lines).toHaveLength(40);
      expect(outcome.content).not.toMatch(/more/);
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
      expect(outcome.isError).toBeUndefined();
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

    it('passes recurrence through and commits when the series is conflict-free (Story 9)', async () => {
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
      // The whole proposed series is conflict-checked (not the one-off
      // findOverlapping path); a clear verdict commits with no hold.
      expect(
        harness.taskService.findRecurringSeriesConflicts,
      ).toHaveBeenCalledTimes(1);
      expect(outcome.isError).toBeUndefined();
    });

    it('REFUSES the whole series with a recoverable default-deny error when a recurring create overlaps (ADR 0011)', async () => {
      const harness = buildDispatcher();

      (
        harness.taskService.findRecurringSeriesConflicts as jest.Mock
      ).mockResolvedValue({
        conflictDates: [
          new Date('2026-06-10T09:00:00.000Z'),
          new Date('2026-06-17T09:00:00.000Z'),
        ],
        conflictingTasks: [{ id: 'task-x', title: 'Gym' } as Task],
      });

      const outcome = await harness.dispatcher.dispatch(
        toolCall('create_task', {
          title: 'Standup',
          startAt: '2026-06-10T09:00:00.000Z',
          endAt: '2026-06-10T09:15:00.000Z',
          recurrence: { frequency: 'WEEKLY', byWeekday: [0, 1, 2, 3, 4] },
        }),
        buildContext(),
      );

      // The series is REFUSED, NOT committed — a recoverable error restating the
      // clash + the default-deny instruction, no hold.
      expect(harness.taskService.create).not.toHaveBeenCalled();
      expect(outcome.isError).toBe(true);
      expect(outcome.content).toMatch(
        /overlaps existing commitments on 2 dates/i,
      );
      expect(outcome.content).toMatch(/Gym/);
      expect(outcome.content).toMatch(/Do NOT book over it/i);
      expect(outcome.content).toMatch(/confirmOverlap/);
    });

    it('books the recurring series when confirmOverlap is set, skipping the series conflict check (ADR 0011)', async () => {
      const harness = buildDispatcher();

      (
        harness.taskService.findRecurringSeriesConflicts as jest.Mock
      ).mockResolvedValue({
        conflictDates: [new Date('2026-06-10T09:00:00.000Z')],
        conflictingTasks: [{ id: 'task-x', title: 'Gym' } as Task],
      });

      const outcome = await harness.dispatcher.dispatch(
        toolCall('create_task', {
          title: 'Standup',
          startAt: '2026-06-10T09:00:00.000Z',
          endAt: '2026-06-10T09:15:00.000Z',
          recurrence: { frequency: 'WEEKLY', byWeekday: [0, 1, 2, 3, 4] },
          confirmOverlap: true,
        }),
        buildContext(),
      );

      // Authorized: the gate is skipped entirely and the series commits.
      expect(
        harness.taskService.findRecurringSeriesConflicts,
      ).not.toHaveBeenCalled();
      expect(harness.taskService.create).toHaveBeenCalledTimes(1);
      expect(outcome.isError).toBeUndefined();
      expect(outcome.content).toMatch(/created/i);
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

    it('CORE SAFETY: refuses a create_task that overlaps with a recoverable default-deny error and NO write (ADR 0011)', async () => {
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

      // No silent double-book: the overlap produces NO write and a recoverable
      // is_error that restates the clash + the default-deny rule (no hold).
      expect(harness.taskService.create).not.toHaveBeenCalled();
      expect(outcome.isError).toBe(true);
      expect(outcome.content).toMatch(/overlaps an existing commitment/i);
      expect(outcome.content).toMatch(/Lunch with Ana/);
      expect(outcome.content).toMatch(/Do NOT book over it/i);
      expect(outcome.content).toMatch(/ask_user/);
    });

    it('books over the overlap only when confirmOverlap is set — the user authorized it (ADR 0011)', async () => {
      const harness = buildDispatcher();

      (harness.taskService.findOverlapping as jest.Mock).mockResolvedValue([
        { id: 'other', title: 'Lunch with Ana' } as Task,
      ]);

      const outcome = await harness.dispatcher.dispatch(
        toolCall('create_task', {
          title: 'Dentist',
          startAt: '2026-06-10T13:30:00.000Z',
          endAt: '2026-06-10T14:30:00.000Z',
          confirmOverlap: true,
        }),
        buildContext(),
      );

      // Authorized: the conflict check is skipped and the write commits.
      expect(harness.taskService.findOverlapping).not.toHaveBeenCalled();
      expect(harness.taskService.create).toHaveBeenCalledTimes(1);
      expect(outcome.isError).toBeUndefined();
      expect(outcome.content).toMatch(/created/i);
    });

    it('CASE 5 — STANDING ALLOW: proceeds over an overlap WITHOUT asking and WITHOUT confirmOverlap (ADR 0011 + 0044)', async () => {
      const harness = buildDispatcher();

      (harness.taskService.findOverlapping as jest.Mock).mockResolvedValue([
        { id: 'other', title: 'Lunch with Ana' } as Task,
      ]);

      const outcome = await harness.dispatcher.dispatch(
        // NO confirmOverlap — the standing ALLOW policy authorizes it on its own.
        toolCall('create_task', {
          title: 'Dentist',
          startAt: '2026-06-10T13:30:00.000Z',
          endAt: '2026-06-10T14:30:00.000Z',
        }),
        buildContextWithPolicy(ConflictPolicy.ALLOW),
      );

      // The gate is skipped entirely (no conflict probe) and the write commits.
      expect(harness.taskService.findOverlapping).not.toHaveBeenCalled();
      expect(harness.taskService.create).toHaveBeenCalledTimes(1);
      expect(outcome.isError).toBeUndefined();
      expect(outcome.content).toMatch(/created/i);
    });

    it('CASE 5 — STANDING DENY: refuses an overlap even when confirmOverlap is set, NO write (ADR 0011 + 0044)', async () => {
      const harness = buildDispatcher();

      (harness.taskService.findOverlapping as jest.Mock).mockResolvedValue([
        { id: 'other', title: 'Lunch with Ana' } as Task,
      ]);

      const outcome = await harness.dispatcher.dispatch(
        // confirmOverlap is set, but the standing DENY policy OVERRIDES it.
        toolCall('create_task', {
          title: 'Dentist',
          startAt: '2026-06-10T13:30:00.000Z',
          endAt: '2026-06-10T14:30:00.000Z',
          confirmOverlap: true,
        }),
        buildContextWithPolicy(ConflictPolicy.DENY),
      );

      // The deny policy forces the check (despite confirmOverlap) and refuses; the
      // restatement says the policy refuses overlaps and confirmOverlap is ignored.
      expect(harness.taskService.findOverlapping).toHaveBeenCalledTimes(1);
      expect(harness.taskService.create).not.toHaveBeenCalled();
      expect(outcome.isError).toBe(true);
      expect(outcome.content).toMatch(/Lunch with Ana/);
      expect(outcome.content).toMatch(/standing policy refuses|do not book/i);
    });
  });

  describe('create_tasks (batch)', () => {
    it('creates every task in input order when all are free (committedCount = N)', async () => {
      const harness = buildDispatcher();

      // Echo each title back so we can assert the per-item summary order.
      (harness.taskService.create as jest.Mock).mockImplementation(
        (_userId: string, dto: { title: string }) =>
          Promise.resolve({ id: 'task-x', title: dto.title }),
      );

      const outcome = await harness.dispatcher.dispatch(
        toolCall('create_tasks', {
          tasks: [
            { title: 'Lesson 1' },
            { title: 'Lesson 2' },
            { title: 'Lesson 3' },
          ],
        }),
        buildContext(),
      );

      expect(harness.taskService.create).toHaveBeenCalledTimes(3);
      // Fanned out in input order.
      expect(
        (harness.taskService.create as jest.Mock).mock.calls.map(
          (call) => call[1].title,
        ),
      ).toEqual(['Lesson 1', 'Lesson 2', 'Lesson 3']);

      expect(outcome.committedCount).toBe(3);
      expect(outcome.attemptedCount).toBe(3);
      expect(outcome.isError).toBeUndefined();
      // Per-item summary, in order.
      expect(outcome.content).toBe(
        '1: created "Lesson 1"; 2: created "Lesson 2"; 3: created "Lesson 3"',
      );
    });

    it('commits the free items and REFUSES the conflicting one with a recoverable restatement (ADR 0011)', async () => {
      const harness = buildDispatcher();

      (harness.taskService.create as jest.Mock).mockImplementation(
        (_userId: string, dto: { title: string }) =>
          Promise.resolve({ id: 'task-x', title: dto.title }),
      );
      // Only the middle (timed) item overlaps; the bare-title ones never call
      // findOverlapping, so it is queried exactly once and conflicts that once.
      (harness.taskService.findOverlapping as jest.Mock).mockResolvedValue([
        { id: 'other', title: 'Tennis' } as Task,
      ]);

      const outcome = await harness.dispatcher.dispatch(
        toolCall('create_tasks', {
          tasks: [
            { title: 'Lesson 1' },
            {
              title: 'Lesson 2',
              startAt: '2026-06-13T08:00:00.000Z',
              endAt: '2026-06-13T11:00:00.000Z',
            },
            { title: 'Lesson 3' },
          ],
        }),
        buildContext(),
      );

      // Two free items committed; the conflicting one was NOT written — one
      // overlap never aborts the batch.
      expect(harness.taskService.create).toHaveBeenCalledTimes(2);
      expect(
        (harness.taskService.create as jest.Mock).mock.calls.map(
          (call) => call[1].title,
        ),
      ).toEqual(['Lesson 1', 'Lesson 3']);

      expect(outcome.committedCount).toBe(2);
      expect(outcome.attemptedCount).toBe(3);
      // The refused item is reported in the per-item summary with its default-deny
      // restatement — no hold channel.
      expect(outcome.content).toMatch(/2: refused/);
      expect(outcome.content).toMatch(/Tennis/);
      expect(outcome.content).toMatch(/Do NOT book over it/i);
    });

    it('rejects an over-25 batch with a recoverable validation error (no write)', async () => {
      const harness = buildDispatcher();

      const tasks = Array.from({ length: 26 }, (_unused, index) => ({
        title: `Lesson ${index + 1}`,
      }));

      const outcome = await harness.dispatcher.dispatch(
        toolCall('create_tasks', { tasks }),
        buildContext(),
      );

      expect(outcome.isError).toBe(true);
      expect(harness.taskService.create).not.toHaveBeenCalled();
      expect(outcome.committedCount).toBeUndefined();
    });

    it('rejects an empty batch with a recoverable validation error (no write)', async () => {
      const harness = buildDispatcher();

      const outcome = await harness.dispatcher.dispatch(
        toolCall('create_tasks', { tasks: [] }),
        buildContext(),
      );

      expect(outcome.isError).toBe(true);
      expect(harness.taskService.create).not.toHaveBeenCalled();
    });
  });

  describe('check_availability', () => {
    it('returns FREE for every slot and calls findOverlapping once per slot with exact bounds', async () => {
      const harness = buildDispatcher();

      const outcome = await harness.dispatcher.dispatch(
        toolCall('check_availability', {
          slots: [
            {
              startAt: '2026-06-02T14:00:00.000Z',
              endAt: '2026-06-02T15:00:00.000Z',
            },
            {
              startAt: '2026-06-02T15:00:00.000Z',
              endAt: '2026-06-02T16:00:00.000Z',
            },
          ],
        }),
        buildContext(),
      );

      // One probe per slot, each with that slot's exact [start, end) bounds and
      // the resolved primary calendar — the SAME call the write-time hold uses.
      expect(harness.taskService.findOverlapping).toHaveBeenCalledTimes(2);
      expect(harness.taskService.findOverlapping).toHaveBeenNthCalledWith(
        1,
        'user-1',
        'cal-1',
        new Date('2026-06-02T14:00:00.000Z'),
        new Date('2026-06-02T15:00:00.000Z'),
        undefined,
      );
      expect(harness.taskService.findOverlapping).toHaveBeenNthCalledWith(
        2,
        'user-1',
        'cal-1',
        new Date('2026-06-02T15:00:00.000Z'),
        new Date('2026-06-02T16:00:00.000Z'),
        undefined,
      );

      expect(outcome.countsAsScheduleFetch).toBe(true);

      const lines = outcome.content.split('\n');

      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatch(/^Slot 1 \(.*\): FREE$/);
      expect(lines[1]).toMatch(/^Slot 2 \(.*\): FREE$/);
    });

    it('reports a busy slot with the conflicting task minted as a handle', async () => {
      const harness = buildDispatcher();
      const handleMap = new HandleMap();

      // The single (busy) slot conflicts with one existing task; the free slot
      // returns []. findOverlapping is queried in order, once per slot.
      (harness.taskService.findOverlapping as jest.Mock)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: 'task-7', title: 'Tennis' } as Task]);

      const outcome = await harness.dispatcher.dispatch(
        toolCall('check_availability', {
          slots: [
            {
              startAt: '2026-06-02T14:00:00.000Z',
              endAt: '2026-06-02T15:00:00.000Z',
            },
            {
              startAt: '2026-06-02T15:00:00.000Z',
              endAt: '2026-06-02T16:00:00.000Z',
            },
          ],
        }),
        buildContext(handleMap),
      );

      const lines = outcome.content.split('\n');

      expect(lines[0]).toMatch(/^Slot 1 \(.*\): FREE$/);
      expect(lines[1]).toMatch(/Slot 2 \(.*\): BUSY — \[e1\] 'Tennis'/);
      // The conflicting task is addressable by its minted handle (a master row,
      // so originalStart is null).
      expect(handleMap.resolve('e1')).toEqual({
        taskId: 'task-7',
        originalStart: null,
      });
    });

    it('counts as a single schedule-fetch and never increments committedWrites', async () => {
      const harness = buildDispatcher();

      const outcome = await harness.dispatcher.dispatch(
        toolCall('check_availability', {
          slots: [
            {
              startAt: '2026-06-02T14:00:00.000Z',
              endAt: '2026-06-02T15:00:00.000Z',
            },
          ],
        }),
        buildContext(),
      );

      // A read, never a write: no create/update, no committed/attempted counts.
      expect(outcome.countsAsScheduleFetch).toBe(true);
      expect(outcome.committedCount).toBeUndefined();
      expect(outcome.attemptedCount).toBeUndefined();
      expect(harness.taskService.create).not.toHaveBeenCalled();
      expect(harness.taskService.update).not.toHaveBeenCalled();
    });

    it('passes excludeTaskId through to findOverlapping', async () => {
      const harness = buildDispatcher();

      await harness.dispatcher.dispatch(
        toolCall('check_availability', {
          slots: [
            {
              startAt: '2026-06-02T14:00:00.000Z',
              endAt: '2026-06-02T15:00:00.000Z',
              excludeTaskId: 'task-self',
            },
          ],
        }),
        buildContext(),
      );

      expect(harness.taskService.findOverlapping).toHaveBeenCalledWith(
        'user-1',
        'cal-1',
        new Date('2026-06-02T14:00:00.000Z'),
        new Date('2026-06-02T15:00:00.000Z'),
        'task-self',
      );
    });

    it('skips an open-ended / rule-shaped slot with a recoverable note rather than a false FREE', async () => {
      const harness = buildDispatcher();

      const outcome = await harness.dispatcher.dispatch(
        toolCall('check_availability', {
          slots: [
            // endAt before startAt — cannot be point-checked.
            {
              startAt: '2026-06-02T15:00:00.000Z',
              endAt: '2026-06-02T14:00:00.000Z',
            },
            {
              startAt: '2026-06-02T16:00:00.000Z',
              endAt: '2026-06-02T17:00:00.000Z',
            },
          ],
        }),
        buildContext(),
      );

      const lines = outcome.content.split('\n');

      // The malformed slot is SKIPPED (never probed) and never called FREE; the
      // valid slot is still checked.
      expect(lines[0]).toMatch(/^Slot 1: SKIPPED/);
      expect(lines[0]).not.toMatch(/FREE/);
      expect(lines[1]).toMatch(/^Slot 2 \(.*\): FREE$/);
      // findOverlapping ran only for the checkable slot.
      expect(harness.taskService.findOverlapping).toHaveBeenCalledTimes(1);
    });

    it('rejects an over-25 batch with a recoverable validation error (no probes)', async () => {
      const harness = buildDispatcher();

      const slots = Array.from({ length: 26 }, (_unused, index) => ({
        startAt: `2026-06-02T${String(index).padStart(2, '0')}:00:00.000Z`,
        endAt: `2026-06-02T${String(index).padStart(2, '0')}:30:00.000Z`,
      }));

      const outcome = await harness.dispatcher.dispatch(
        toolCall('check_availability', { slots }),
        buildContext(),
      );

      expect(outcome.isError).toBe(true);
      expect(harness.taskService.findOverlapping).not.toHaveBeenCalled();
      expect(outcome.countsAsScheduleFetch).toBeUndefined();
    });

    it('rejects an empty batch with a recoverable validation error (no probes)', async () => {
      const harness = buildDispatcher();

      const outcome = await harness.dispatcher.dispatch(
        toolCall('check_availability', { slots: [] }),
        buildContext(),
      );

      expect(outcome.isError).toBe(true);
      expect(harness.taskService.findOverlapping).not.toHaveBeenCalled();
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

    it('forwards notes, isAllDay, and timezone straight through to the one-off update', async () => {
      // The plain content fields are not gated and not transformed — they reach
      // the service exactly as the model passed them.
      const harness = buildDispatcher();
      const handleMap = new HandleMap();
      const alias = handleMap.add({ taskId: 'task-1', originalStart: null });

      await harness.dispatcher.dispatch(
        toolCall('update_task', {
          handle: alias,
          notes: 'Bring the X-rays',
          isAllDay: true,
          timezone: 'Europe/Berlin',
        }),
        buildContext(handleMap),
      );

      expect(harness.taskService.update).toHaveBeenCalledWith(
        'user-1',
        'task-1',
        {
          notes: 'Bring the X-rays',
          isAllDay: true,
          timezone: 'Europe/Berlin',
        },
      );
    });

    it('un-groups a one-off task — an explicit group:null forwards groupId:null', async () => {
      // Tri-state group: a present-but-null key means "un-group", forwarded as the
      // literal groupId:null (resolveGroup is bypassed, so findByName never runs).
      const harness = buildDispatcher();
      const handleMap = new HandleMap();
      const alias = handleMap.add({ taskId: 'task-1', originalStart: null });

      await harness.dispatcher.dispatch(
        toolCall('update_task', { handle: alias, group: null }),
        buildContext(handleMap),
      );

      expect(harness.taskGroupService.findByName).not.toHaveBeenCalled();
      expect(harness.taskService.update).toHaveBeenCalledWith(
        'user-1',
        'task-1',
        { groupId: null },
      );
    });

    it('reverts a timed one-off to a todo — an explicit startAt:null forwards startAt:null with no conflict probe', async () => {
      // Clearing the start makes the task timeless: the write carries the literal
      // startAt:null and the conflict gate is skipped (no concrete window to check).
      const harness = buildDispatcher();
      const handleMap = new HandleMap();
      const alias = handleMap.add({ taskId: 'task-1', originalStart: null });

      await harness.dispatcher.dispatch(
        toolCall('update_task', { handle: alias, startAt: null }),
        buildContext(handleMap),
      );

      expect(harness.taskService.findOverlapping).not.toHaveBeenCalled();
      expect(harness.taskService.update).toHaveBeenCalledWith(
        'user-1',
        'task-1',
        { startAt: null },
      );
    });

    it('stops a one-off repeating — an explicit recurrence:null forwards recurrence:null', async () => {
      // Tri-state recurrence: a present-but-null key clears the rule, forwarded as
      // the literal recurrence:null (the service deletes the inline config).
      const harness = buildDispatcher();
      const handleMap = new HandleMap();
      const alias = handleMap.add({ taskId: 'task-1', originalStart: null });

      await harness.dispatcher.dispatch(
        toolCall('update_task', { handle: alias, recurrence: null }),
        buildContext(handleMap),
      );

      expect(harness.taskService.update).toHaveBeenCalledWith(
        'user-1',
        'task-1',
        { recurrence: null },
      );
    });

    it('changes a one-off recurrence — a recurrence object forwards the mapped DTO', async () => {
      // A recurrence object is mapped through toRecurrenceDto and forwarded as the
      // structural DTO the task service consumes.
      const harness = buildDispatcher();
      const handleMap = new HandleMap();
      const alias = handleMap.add({ taskId: 'task-1', originalStart: null });

      await harness.dispatcher.dispatch(
        toolCall('update_task', {
          handle: alias,
          recurrence: { frequency: 'WEEKLY', byWeekday: [0, 2, 4] },
        }),
        buildContext(handleMap),
      );

      expect(harness.taskService.update).toHaveBeenCalledWith(
        'user-1',
        'task-1',
        {
          recurrence: expect.objectContaining({
            frequency: 'WEEKLY',
            byWeekday: [0, 2, 4],
          }),
        },
      );
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
        recurrenceConfig: { frequency: 'DAILY' },
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

    it('applies an occurrence override for editScope "this" when the move is clear', async () => {
      const harness = buildDispatcher();

      // A timed master gives the moved occurrence a concrete window, so the gate
      // runs `findOverlapping` (which returns clear here) before the override.
      (harness.taskService.findById as jest.Mock).mockResolvedValue({
        id: 'task-1',
        recurrenceConfig: { frequency: 'DAILY' },
        calendarId: 'cal-1',
        startAt: new Date('2026-06-03T09:00:00.000Z'),
        endAt: new Date('2026-06-03T09:30:00.000Z'),
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

      // The gate consulted findOverlapping for the new occurrence window
      // [10:00, 10:30) — carrying the 30-min series duration — excluding the
      // series' own anchor, then (clear) committed the override.
      expect(harness.taskService.findOverlapping).toHaveBeenCalledWith(
        'user-1',
        'cal-1',
        new Date('2026-06-03T10:00:00.000Z'),
        new Date('2026-06-03T10:30:00.000Z'),
        'task-1',
      );
      expect(harness.taskService.applyOccurrenceOverride).toHaveBeenCalledWith(
        'user-1',
        'task-1',
        new Date('2026-06-03T09:00:00.000Z'),
        { overrideStartAt: new Date('2026-06-03T10:00:00.000Z') },
      );
    });

    it('conflict-checks a start-only "this" move against the occurrence\'s TRUE prior span, not the master duration', async () => {
      // The under-detection edge: this occurrence was previously STRETCHED to 2h
      // (override 14:00–16:00) while the series master is only 30m (09:00–09:30).
      // A start-only move to 17:00 must be checked against the real 2h window
      // [17:00, 19:00) — NOT the 30m [17:00, 17:30) the master duration implies —
      // or a clash sitting in the 30-min..2h tail slips past the gate.
      const harness = buildDispatcher();

      (harness.taskService.findById as jest.Mock).mockResolvedValue({
        id: 'task-1',
        recurrenceConfig: { frequency: 'DAILY' },
        calendarId: 'cal-1',
        startAt: new Date('2026-06-03T09:00:00.000Z'),
        endAt: new Date('2026-06-03T09:30:00.000Z'),
      });
      (
        harness.taskService.findOccurrenceException as jest.Mock
      ).mockResolvedValue({
        taskId: 'task-1',
        originalStartAt: new Date('2026-06-03T09:00:00.000Z'),
        overrideStartAt: new Date('2026-06-03T14:00:00.000Z'),
        overrideEndAt: new Date('2026-06-03T16:00:00.000Z'),
        overrideTitle: null,
        isSkipped: false,
        completedAt: null,
      });

      const handleMap = new HandleMap();
      const alias = handleMap.add({
        taskId: 'task-1',
        originalStart: new Date('2026-06-03T09:00:00.000Z'),
      });

      await harness.dispatcher.dispatch(
        toolCall('update_task', {
          handle: alias,
          startAt: '2026-06-03T17:00:00.000Z',
          editScope: 'this',
        }),
        buildContext(handleMap),
      );

      // Checked window carries the occurrence's TRUE 2h span from the new start.
      expect(harness.taskService.findOverlapping).toHaveBeenCalledWith(
        'user-1',
        'cal-1',
        new Date('2026-06-03T17:00:00.000Z'),
        new Date('2026-06-03T19:00:00.000Z'),
        'task-1',
      );
    });

    it('persists a coherent (non-inverted) window for a start-only "this" move on a prior-stretched occurrence', async () => {
      // The write counterpart: a bare `overrideStartAt` write would strand the
      // prior `overrideEndAt` (16:00) paired with the new start (17:00) — an
      // INVERTED window. The fix slides the end with the start to preserve the
      // 2h span, persisting both overrideStartAt 17:00 AND overrideEndAt 19:00.
      const harness = buildDispatcher();

      (harness.taskService.findById as jest.Mock).mockResolvedValue({
        id: 'task-1',
        recurrenceConfig: { frequency: 'DAILY' },
        calendarId: 'cal-1',
        startAt: new Date('2026-06-03T09:00:00.000Z'),
        endAt: new Date('2026-06-03T09:30:00.000Z'),
      });
      (
        harness.taskService.findOccurrenceException as jest.Mock
      ).mockResolvedValue({
        taskId: 'task-1',
        originalStartAt: new Date('2026-06-03T09:00:00.000Z'),
        overrideStartAt: new Date('2026-06-03T14:00:00.000Z'),
        overrideEndAt: new Date('2026-06-03T16:00:00.000Z'),
        overrideTitle: null,
        isSkipped: false,
        completedAt: null,
      });

      const handleMap = new HandleMap();
      const alias = handleMap.add({
        taskId: 'task-1',
        originalStart: new Date('2026-06-03T09:00:00.000Z'),
      });

      await harness.dispatcher.dispatch(
        toolCall('update_task', {
          handle: alias,
          startAt: '2026-06-03T17:00:00.000Z',
          editScope: 'this',
        }),
        buildContext(handleMap),
      );

      expect(harness.taskService.applyOccurrenceOverride).toHaveBeenCalledWith(
        'user-1',
        'task-1',
        new Date('2026-06-03T09:00:00.000Z'),
        {
          overrideStartAt: new Date('2026-06-03T17:00:00.000Z'),
          overrideEndAt: new Date('2026-06-03T19:00:00.000Z'),
        },
      );
    });

    it('leaves the common-path start-only "this" move unchanged when there is no prior override', async () => {
      // Guardrail: with no existing exception the behaviour is byte-identical to
      // before — the gate checks the master-duration window and the write sets
      // only `overrideStartAt` (the read derives the end off the new start).
      const harness = buildDispatcher();

      (harness.taskService.findById as jest.Mock).mockResolvedValue({
        id: 'task-1',
        recurrenceConfig: { frequency: 'DAILY' },
        calendarId: 'cal-1',
        startAt: new Date('2026-06-03T09:00:00.000Z'),
        endAt: new Date('2026-06-03T09:30:00.000Z'),
      });
      // findOccurrenceException defaults to null (no prior override).

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

      expect(harness.taskService.findOverlapping).toHaveBeenCalledWith(
        'user-1',
        'cal-1',
        new Date('2026-06-03T10:00:00.000Z'),
        new Date('2026-06-03T10:30:00.000Z'),
        'task-1',
      );
      expect(harness.taskService.applyOccurrenceOverride).toHaveBeenCalledWith(
        'user-1',
        'task-1',
        new Date('2026-06-03T09:00:00.000Z'),
        { overrideStartAt: new Date('2026-06-03T10:00:00.000Z') },
      );
    });

    it('REFUSES a "this"-scope occurrence move onto an overlap (no auth, no policy) and does NOT write', async () => {
      // THE CORE no-double-book assertion: moving one occurrence onto an existing
      // commitment without authorization must be refused with a recoverable
      // is_error and must NOT call applyOccurrenceOverride.
      const harness = buildDispatcher();

      (harness.taskService.findById as jest.Mock).mockResolvedValue({
        id: 'task-1',
        recurrenceConfig: { frequency: 'DAILY' },
        calendarId: 'cal-1',
        startAt: new Date('2026-06-03T09:00:00.000Z'),
        endAt: new Date('2026-06-03T09:30:00.000Z'),
      });
      (harness.taskService.findOverlapping as jest.Mock).mockResolvedValue([
        { id: 'other-1', title: 'Dentist' },
      ]);

      const handleMap = new HandleMap();
      const alias = handleMap.add({
        taskId: 'task-1',
        originalStart: new Date('2026-06-03T09:00:00.000Z'),
      });

      const outcome = await harness.dispatcher.dispatch(
        toolCall('update_task', {
          handle: alias,
          startAt: '2026-06-03T10:00:00.000Z',
          editScope: 'this',
        }),
        buildContext(handleMap),
      );

      expect(outcome.isError).toBe(true);
      expect(outcome.content).toMatch(/overlaps an existing commitment/i);
      expect(outcome.content).toContain('Dentist');
      // NO double-book: the override never ran.
      expect(
        harness.taskService.applyOccurrenceOverride,
      ).not.toHaveBeenCalled();
    });

    it('proceeds with a "this"-scope move onto an overlap when confirmOverlap is set', async () => {
      const harness = buildDispatcher();

      (harness.taskService.findById as jest.Mock).mockResolvedValue({
        id: 'task-1',
        recurrenceConfig: { frequency: 'DAILY' },
        calendarId: 'cal-1',
        startAt: new Date('2026-06-03T09:00:00.000Z'),
        endAt: new Date('2026-06-03T09:30:00.000Z'),
      });
      (harness.taskService.findOverlapping as jest.Mock).mockResolvedValue([
        { id: 'other-1', title: 'Dentist' },
      ]);

      const handleMap = new HandleMap();
      const alias = handleMap.add({
        taskId: 'task-1',
        originalStart: new Date('2026-06-03T09:00:00.000Z'),
      });

      const outcome = await harness.dispatcher.dispatch(
        toolCall('update_task', {
          handle: alias,
          startAt: '2026-06-03T10:00:00.000Z',
          editScope: 'this',
          confirmOverlap: true,
        }),
        buildContext(handleMap),
      );

      expect(outcome.isError).toBeFalsy();
      // Authorized: the gate is skipped (findOverlapping not even consulted) and
      // the override commits.
      expect(harness.taskService.findOverlapping).not.toHaveBeenCalled();
      expect(harness.taskService.applyOccurrenceOverride).toHaveBeenCalledWith(
        'user-1',
        'task-1',
        new Date('2026-06-03T09:00:00.000Z'),
        { overrideStartAt: new Date('2026-06-03T10:00:00.000Z') },
      );
    });

    it('REFUSES a "this"-scope move onto an overlap under a DENY policy even with confirmOverlap', async () => {
      // A standing DENY overrides an in-message confirmOverlap: the gate runs and
      // the move is refused with the deny restatement; no write.
      const harness = buildDispatcher();

      (harness.taskService.findById as jest.Mock).mockResolvedValue({
        id: 'task-1',
        recurrenceConfig: { frequency: 'DAILY' },
        calendarId: 'cal-1',
        startAt: new Date('2026-06-03T09:00:00.000Z'),
        endAt: new Date('2026-06-03T09:30:00.000Z'),
      });
      (harness.taskService.findOverlapping as jest.Mock).mockResolvedValue([
        { id: 'other-1', title: 'Dentist' },
      ]);

      const handleMap = new HandleMap();
      const alias = handleMap.add({
        taskId: 'task-1',
        originalStart: new Date('2026-06-03T09:00:00.000Z'),
      });

      const outcome = await harness.dispatcher.dispatch(
        toolCall('update_task', {
          handle: alias,
          startAt: '2026-06-03T10:00:00.000Z',
          editScope: 'this',
          confirmOverlap: true,
        }),
        buildContextWithPolicy(ConflictPolicy.DENY, handleMap),
      );

      expect(outcome.isError).toBe(true);
      expect(outcome.content).toMatch(/standing policy refuses overlaps/i);
      expect(
        harness.taskService.applyOccurrenceOverride,
      ).not.toHaveBeenCalled();
    });

    it('does NOT conflict-check a "this"-scope pure rename (no time change) and proceeds', async () => {
      // Proves we did not over-gate harmless edits: a rename carries no startAt /
      // endAt, so the gate is skipped entirely and the override commits.
      const harness = buildDispatcher();

      (harness.taskService.findById as jest.Mock).mockResolvedValue({
        id: 'task-1',
        recurrenceConfig: { frequency: 'DAILY' },
        calendarId: 'cal-1',
        startAt: new Date('2026-06-03T09:00:00.000Z'),
        endAt: new Date('2026-06-03T09:30:00.000Z'),
      });

      const handleMap = new HandleMap();
      const alias = handleMap.add({
        taskId: 'task-1',
        originalStart: new Date('2026-06-03T09:00:00.000Z'),
      });

      await harness.dispatcher.dispatch(
        toolCall('update_task', {
          handle: alias,
          title: 'Renamed occurrence',
          editScope: 'this',
        }),
        buildContext(handleMap),
      );

      expect(harness.taskService.findOverlapping).not.toHaveBeenCalled();
      expect(harness.taskService.applyOccurrenceOverride).toHaveBeenCalledWith(
        'user-1',
        'task-1',
        new Date('2026-06-03T09:00:00.000Z'),
        { overrideTitle: 'Renamed occurrence' },
      );
    });

    it('splits the series for editScope "this_and_following"', async () => {
      const harness = buildDispatcher();

      (harness.taskService.findById as jest.Mock).mockResolvedValue({
        id: 'task-1',
        recurrenceConfig: { frequency: 'DAILY' },
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
        recurrenceConfig: { frequency: 'DAILY' },
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

    it('carries requiresCompletion / color / notes INTO the split for "this_and_following" (not dropped)', async () => {
      // The new series must retarget these fields atomically in the same insert —
      // a "this_and_following" edit of them is passed into splitSeries, never lost
      // and never applied as a separate follow-up update.
      const harness = buildDispatcher();

      (harness.taskService.findById as jest.Mock).mockResolvedValue({
        id: 'task-1',
        recurrenceConfig: { frequency: 'DAILY' },
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
          requiresCompletion: true,
          color: 'BLUE',
          notes: 'Pack the kit',
          editScope: 'this_and_following',
        }),
        buildContext(handleMap),
      );

      expect(harness.taskService.splitSeries).toHaveBeenCalledWith(
        'user-1',
        'task-1',
        new Date('2026-06-03T09:00:00.000Z'),
        {
          requiresCompletion: true,
          color: 'BLUE',
          notes: 'Pack the kit',
        },
      );
      expect(harness.taskService.update).not.toHaveBeenCalled();
    });

    it('surfaces a cross-calendar group rejection from splitSeries as a recoverable error (no follow-up write)', async () => {
      const harness = buildDispatcher();

      (harness.taskService.findById as jest.Mock).mockResolvedValue({
        id: 'task-1',
        recurrenceConfig: { frequency: 'DAILY' },
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
        recurrenceConfig: { frequency: 'DAILY' },
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
        recurrenceConfig: { frequency: 'DAILY' },
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
        recurrenceConfig: { frequency: 'DAILY' },
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

    it('REFUSES an "all" recurring edit that introduces an overlap with a recoverable default-deny error (ADR 0011)', async () => {
      const harness = buildDispatcher();

      (harness.taskService.findById as jest.Mock).mockResolvedValue({
        id: 'task-1',
        recurrenceConfig: { frequency: 'DAILY' },
        calendarId: 'cal-1',
      });
      (
        harness.taskService.findRecurringEditConflicts as jest.Mock
      ).mockResolvedValue({
        conflictDates: [new Date('2026-06-10T10:00:00.000Z')],
        conflictingTasks: [{ id: 'task-x', title: 'Lunch' } as Task],
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
          endAt: '2026-06-03T10:30:00.000Z',
          editScope: 'all',
        }),
        buildContext(handleMap),
      );

      // Refused, not written — the conflict check ran with the proposed time.
      expect(
        harness.taskService.findRecurringEditConflicts,
      ).toHaveBeenCalledWith('user-1', 'task-1', {
        startAt: '2026-06-03T10:00:00.000Z',
        endAt: '2026-06-03T10:30:00.000Z',
      });
      expect(harness.taskService.update).not.toHaveBeenCalled();
      expect(outcome.isError).toBe(true);
      expect(outcome.content).toMatch(/Lunch/);
      expect(outcome.content).toMatch(/Do NOT book over it/i);
    });

    it('REFUSES a "this_and_following" recurring edit that introduces an overlap (ADR 0011)', async () => {
      const harness = buildDispatcher();

      (harness.taskService.findById as jest.Mock).mockResolvedValue({
        id: 'task-1',
        recurrenceConfig: { frequency: 'DAILY' },
        calendarId: 'cal-1',
      });
      (
        harness.taskService.findRecurringEditConflicts as jest.Mock
      ).mockResolvedValue({
        conflictDates: [new Date('2026-06-10T10:00:00.000Z')],
        conflictingTasks: [{ id: 'task-x', title: 'Gym' } as Task],
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
          endAt: '2026-06-03T10:30:00.000Z',
          editScope: 'this_and_following',
        }),
        buildContext(handleMap),
      );

      // The split is NOT performed — the edit is refused first.
      expect(harness.taskService.splitSeries).not.toHaveBeenCalled();
      expect(outcome.isError).toBe(true);
      expect(outcome.content).toMatch(/Gym/);
      expect(outcome.content).toMatch(/Do NOT book over it/i);
    });

    it('books a "this_and_following" recurring edit over the clash when confirmOverlap is set (ADR 0011)', async () => {
      const harness = buildDispatcher();

      (harness.taskService.findById as jest.Mock).mockResolvedValue({
        id: 'task-1',
        recurrenceConfig: { frequency: 'DAILY' },
        calendarId: 'cal-1',
      });
      (
        harness.taskService.findRecurringEditConflicts as jest.Mock
      ).mockResolvedValue({
        conflictDates: [new Date('2026-06-10T10:00:00.000Z')],
        conflictingTasks: [{ id: 'task-x', title: 'Gym' } as Task],
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
          endAt: '2026-06-03T10:30:00.000Z',
          editScope: 'this_and_following',
          confirmOverlap: true,
        }),
        buildContext(handleMap),
      );

      // Authorized: the conflict check is skipped and the split runs.
      expect(
        harness.taskService.findRecurringEditConflicts,
      ).not.toHaveBeenCalled();
      expect(harness.taskService.splitSeries).toHaveBeenCalledTimes(1);
      expect(outcome.isError).toBeUndefined();
    });

    it('commits a recurring "all" edit when the series stays conflict-free (Story 9)', async () => {
      const harness = buildDispatcher();

      (harness.taskService.findById as jest.Mock).mockResolvedValue({
        id: 'task-1',
        recurrenceConfig: { frequency: 'DAILY' },
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
          endAt: '2026-06-03T10:30:00.000Z',
          editScope: 'all',
        }),
        buildContext(handleMap),
      );

      expect(
        harness.taskService.findRecurringEditConflicts,
      ).toHaveBeenCalledTimes(1);
      expect(harness.taskService.update).toHaveBeenCalledTimes(1);
      expect(outcome.isError).toBeUndefined();
    });

    it('CORE SAFETY: refuses a one-off timed move that overlaps with a recoverable error and NO write (ADR 0011)', async () => {
      const harness = buildDispatcher();

      (harness.taskService.findById as jest.Mock).mockResolvedValue({
        id: 'task-1',
        recurrenceConfig: null,
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

      // No silent double-book: the overlap produces NO write and a recoverable
      // default-deny restatement.
      expect(outcome.isError).toBe(true);
      expect(outcome.content).toMatch(/overlaps an existing commitment/i);
      expect(outcome.content).toMatch(/Lunch/);
      expect(harness.taskService.update).not.toHaveBeenCalled();
    });

    it('moves the one-off over the clash only when confirmOverlap is set (ADR 0011)', async () => {
      const harness = buildDispatcher();

      (harness.taskService.findById as jest.Mock).mockResolvedValue({
        id: 'task-1',
        recurrenceConfig: null,
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
          confirmOverlap: true,
        }),
        buildContext(handleMap),
      );

      // Authorized: the conflict check is skipped and the move commits.
      expect(harness.taskService.findOverlapping).not.toHaveBeenCalled();
      expect(harness.taskService.update).toHaveBeenCalledTimes(1);
      expect(outcome.isError).toBeUndefined();
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
        recurrenceConfig: { frequency: 'DAILY' },
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
        recurrenceConfig: { frequency: 'DAILY' },
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
          editScope: 'this',
          confirmDelete: true,
        }),
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
        recurrenceConfig: { frequency: 'DAILY' },
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
        recurrenceConfig: { frequency: 'DAILY' },
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
          confirmDelete: true,
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
        toolCall('delete_task', { handle: alias, confirmDelete: true }),
        buildContext(handleMap),
      );

      expect(harness.taskService.remove).toHaveBeenCalledWith(
        'user-1',
        'task-1',
      );
      expect(outcome.content).toMatch(/deleted/i);
    });

    it('CASE 4 — DESTRUCTIVE REPLACE: refuses a one-off delete without confirmDelete and asks first, NO write (ADR 0011 + 0044)', async () => {
      const harness = buildDispatcher();
      const handleMap = new HandleMap();
      const alias = handleMap.add({ taskId: 'task-1', originalStart: null });

      const outcome = await harness.dispatcher.dispatch(
        // No confirmDelete: a destructive delete must ask first.
        toolCall('delete_task', { handle: alias }),
        buildContext(handleMap),
      );

      expect(outcome.isError).toBe(true);
      expect(outcome.content).toMatch(/destructive|ask the user|confirm/i);
      expect(outcome.content).toMatch(/confirmDelete/);
      // Nothing was destroyed.
      expect(harness.taskService.remove).not.toHaveBeenCalled();
      expect(
        harness.taskService.applyOccurrenceOverride,
      ).not.toHaveBeenCalled();
      expect(harness.taskService.endSeriesAt).not.toHaveBeenCalled();
    });

    it('CASE 4 — DESTRUCTIVE REPLACE: a standing ALLOW policy does NOT authorize a delete — still asks first (ADR 0011 + 0044)', async () => {
      const harness = buildDispatcher();
      const handleMap = new HandleMap();
      const alias = handleMap.add({ taskId: 'task-1', originalStart: null });

      const outcome = await harness.dispatcher.dispatch(
        toolCall('delete_task', { handle: alias }),
        // Even with the most permissive standing policy, a delete is irreversible.
        buildContextWithPolicy(ConflictPolicy.ALLOW, handleMap),
      );

      expect(outcome.isError).toBe(true);
      expect(outcome.content).toMatch(/confirmDelete/);
      expect(harness.taskService.remove).not.toHaveBeenCalled();
    });

    it('DESTRUCTIVE REPLACE: a recurring delete without a scope still asks for scope first (before the delete-confirm gate)', async () => {
      const harness = buildDispatcher();

      (harness.taskService.findById as jest.Mock).mockResolvedValue({
        id: 'task-1',
        recurrenceConfig: { frequency: 'DAILY' },
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

      // Scope question precedes the delete-confirm gate — the model must know the
      // extent before confirming — but still NO destructive write.
      expect(outcome.isError).toBe(true);
      expect(outcome.content).toMatch(/repeating task/i);
      expect(harness.taskService.remove).not.toHaveBeenCalled();
      expect(harness.taskService.endSeriesAt).not.toHaveBeenCalled();
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

    it('caps a long group list and appends a "(+N more)" hint', async () => {
      const harness = buildDispatcher();
      // 45 groups → 40 names listed + a "(+5 more)" suffix.
      const groups = Array.from(
        { length: 45 },
        (_unused, index) =>
          ({ id: `g-${index}`, name: `Group ${index}` }) as TaskGroup,
      );

      (harness.taskGroupService.findAllForUser as jest.Mock).mockResolvedValue(
        groups,
      );

      const outcome = await harness.dispatcher.dispatch(
        toolCall('list_groups', {}),
        buildContext(),
      );

      const content = outcome.content;

      expect(content).toMatch(/\(\+5 more\)$/);
      // Exactly 40 names precede the hint (39 separating commas).
      expect(content.replace(' (+5 more)', '').split(', ')).toHaveLength(40);
      expect(content).toContain('Group 0');
      expect(content).toContain('Group 39');
      expect(content).not.toContain('Group 40');
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
        requiresCompletion: undefined,
        recurrence: undefined,
      });
      expect(outcome.content).toMatch(/created group/i);
    });

    it('creates a group with inherited defaults (color, recurrence, requiresCompletion)', async () => {
      const harness = buildDispatcher();

      const outcome = await harness.dispatcher.dispatch(
        toolCall('create_group', {
          name: 'Gym',
          color: 'BLUE',
          recurrence: { frequency: 'DAILY' },
          requiresCompletion: true,
        }),
        buildContext(),
      );

      expect(harness.taskGroupService.create).toHaveBeenCalledWith('user-1', {
        calendarId: 'cal-1',
        name: 'Gym',
        color: 'BLUE',
        icon: undefined,
        requiresCompletion: true,
        recurrence: expect.objectContaining({ frequency: 'DAILY' }),
      });
      expect(outcome.content).toMatch(/created group/i);
    });

    it('updates a group by name through update_group', async () => {
      const harness = buildDispatcher();

      const outcome = await harness.dispatcher.dispatch(
        toolCall('update_group', {
          group: 'Work',
          color: 'GREEN',
          recurrence: null,
        }),
        buildContext(),
      );

      expect(harness.taskGroupService.findByName).toHaveBeenCalledWith(
        'user-1',
        'Work',
      );
      expect(harness.taskGroupService.update).toHaveBeenCalledWith(
        'user-1',
        'grp-1',
        expect.objectContaining({ color: 'GREEN', recurrence: null }),
      );
      expect(outcome.content).toMatch(/updated group/i);
    });

    it('reorders a group — update_group forwards sortOrder to the service', async () => {
      const harness = buildDispatcher();

      await harness.dispatcher.dispatch(
        toolCall('update_group', { group: 'Work', sortOrder: 3 }),
        buildContext(),
      );

      expect(harness.taskGroupService.update).toHaveBeenCalledWith(
        'user-1',
        'grp-1',
        expect.objectContaining({ sortOrder: 3 }),
      );
    });

    it('stops a group repeating — an explicit recurrence:null forwards exactly recurrence:null', async () => {
      // Tri-state recurrence on the group default: a present-but-null key clears
      // it, forwarded as the literal recurrence:null with no other field touched.
      const harness = buildDispatcher();

      await harness.dispatcher.dispatch(
        toolCall('update_group', { group: 'Work', recurrence: null }),
        buildContext(),
      );

      expect(harness.taskGroupService.update).toHaveBeenCalledWith(
        'user-1',
        'grp-1',
        { recurrence: null },
      );
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

  describe('ask_user (ADR 0010)', () => {
    it('returns the askUser sentinel and touches NO feature service / DB', async () => {
      const harness = buildDispatcher();

      const outcome = await harness.dispatcher.dispatch(
        toolCall('ask_user', {
          question: 'Which day works?',
          options: [
            { id: 'fri', label: 'Friday' },
            { id: 'sat', label: 'Saturday' },
          ],
        }),
        buildContext(),
      );

      expect(outcome.askUser).toEqual({
        question: 'Which day works?',
        options: [
          { id: 'fri', label: 'Friday' },
          { id: 'sat', label: 'Saturday' },
        ],
      });
      expect(outcome.isError).toBeUndefined();

      // The tool itself performs no calendar work — the orchestrator suspends.
      expect(harness.taskService.create).not.toHaveBeenCalled();
      expect(harness.taskService.update).not.toHaveBeenCalled();
      expect(harness.taskService.findOverlapping).not.toHaveBeenCalled();
      expect(harness.scheduleReader.occurrencesInRange).not.toHaveBeenCalled();
    });

    it('normalizes an omitted options list to an empty array (plain free-text question)', async () => {
      const harness = buildDispatcher();

      const outcome = await harness.dispatcher.dispatch(
        toolCall('ask_user', { question: 'What time?' }),
        buildContext(),
      );

      expect(outcome.askUser).toEqual({
        question: 'What time?',
        options: [],
      });
    });

    it('rejects more than 4 options as a recoverable validation error (no sentinel)', async () => {
      const harness = buildDispatcher();

      const outcome = await harness.dispatcher.dispatch(
        toolCall('ask_user', {
          question: 'Pick one',
          options: [
            { id: 'a', label: 'A' },
            { id: 'b', label: 'B' },
            { id: 'c', label: 'C' },
            { id: 'd', label: 'D' },
            { id: 'e', label: 'E' },
          ],
        }),
        buildContext(),
      );

      expect(outcome.isError).toBe(true);
      expect(outcome.askUser).toBeUndefined();
    });
  });
});
