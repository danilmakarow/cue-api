import { BadRequestException } from '@nestjs/common';
import { DateTime } from 'luxon';
import { FindManyOptions, FindOptionsWhere } from 'typeorm';

import { TaskService } from './task.service';
import {
  Calendar,
  RecurrenceEndType,
  RecurrenceFrequency,
  RecurrenceRule,
  Task,
  TaskGroup,
  TaskOccurrenceException,
} from '@/modules/database/entities';
import { RecurrenceRuleService } from '@/modules/recurrence-rule/recurrence-rule.service';

/**
 * Minimal shape of a TypeORM FindOperator as seen from the test router — only
 * the discriminating `type` tag and wrapped `value` are read.
 */
interface FindOperatorLike {
  type: string;
  value: unknown;
}

/**
 * Returns the operator tag of a where-clause field, or null when the field is a
 * plain value rather than a FindOperator.
 */
const operatorType = (value: unknown): string | null => {
  if (value && typeof value === 'object' && 'type' in value) {
    return (value as FindOperatorLike).type;
  }

  return null;
};

/**
 * Extracts the excluded id from a `where.id = Not(<id>)` clause, or null when no
 * such exclusion is present.
 */
const excludedId = (where: FindOptionsWhere<Task>): string | null => {
  if (operatorType(where.id) !== 'not') return null;

  return (where.id as unknown as FindOperatorLike).value as string;
};

/**
 * Converts a wall-clock spec in a zone to the UTC instant a column would hold.
 */
const zoned = (iso: string, zone = 'America/New_York'): Date =>
  DateTime.fromISO(iso, { zone }).toJSDate();

/**
 * Returns the ISO date (yyyy-mm-dd) of an instant in the given zone.
 */
const localDate = (date: Date | null, zone = 'America/New_York'): string =>
  DateTime.fromJSDate(date as Date, { zone }).toISODate() as string;

/**
 * Builds a Task with sensible defaults; override only what a test cares about.
 */
const makeTask = (overrides: Partial<Task> = {}): Task =>
  ({
    id: 'task-1',
    calendarId: 'cal-1',
    groupId: null,
    title: 'Task',
    notes: null,
    startAt: null,
    endAt: null,
    isAllDay: false,
    timezone: 'America/New_York',
    requiresCompletion: true,
    completedAt: null,
    notificationStrategyId: null,
    recurrenceRuleId: null,
    recurrenceRule: null,
    deletedAt: null,
    ...overrides,
  }) as Task;

/**
 * Builds a RecurrenceRule (DAILY / NEVER defaults).
 */
const makeRule = (overrides: Partial<RecurrenceRule> = {}): RecurrenceRule =>
  ({
    id: 'rule-1',
    frequency: RecurrenceFrequency.DAILY,
    interval: 1,
    byWeekday: null,
    byMonthDay: null,
    byMonth: null,
    endType: RecurrenceEndType.NEVER,
    endDate: null,
    count: null,
    ...overrides,
  }) as RecurrenceRule;

/**
 * The fixtures a routed `taskDatabaseService.findAll` may return, keyed by query
 * bucket. Anything unset defaults to an empty array.
 */
interface RangeFixtures {
  timedWithEnd?: Task[];
  timedNoEnd?: Task[];
  todos?: Task[];
  recurring?: Task[];
  /** Tasks with no own rule but assigned to a group that has a default rule. */
  groupInherited?: Task[];
}

/**
 * Builds a `taskDatabaseService.findAll` that classifies the incoming where
 * clause into a query bucket and returns the matching fixture — letting one mock
 * back the several reads `findOccurrencesInRange` / `findOverlapping` issue.
 * Honors a `completedAt: IsNull()` clause (the conflict-check completed filter)
 * by dropping completed rows, so that filter can be asserted end-to-end.
 *
 * Routing logic:
 * - `recurrenceRuleId: Not(IsNull())` → `recurring` (own-rule anchors)
 * - `recurrenceRuleId: IsNull()` + `groupId: Not(IsNull())` → `groupInherited`
 * - `startAt: IsNull()` → `todos`
 * - `endAt: IsNull()` → `timedNoEnd`
 * - otherwise → `timedWithEnd`
 */
const routedFindAll = (fixtures: RangeFixtures) =>
  jest.fn((options?: FindManyOptions<Task>) => {
    const where = (options?.where ?? {}) as FindOptionsWhere<Task>;
    const recurrenceTag = operatorType(where.recurrenceRuleId);
    const groupIdTag = operatorType(where.groupId);
    const excluded = excludedId(where);
    const dropsCompleted = operatorType(where.completedAt) === 'isNull';

    const bucket = (() => {
      if (recurrenceTag === 'not') return fixtures.recurring ?? [];
      // group-inherited: recurrenceRuleId IS NULL + groupId IS NOT NULL
      if (recurrenceTag === 'isNull' && groupIdTag === 'not')
        return fixtures.groupInherited ?? [];
      if (operatorType(where.startAt) === 'isNull') return fixtures.todos ?? [];
      if (operatorType(where.endAt) === 'isNull')
        return fixtures.timedNoEnd ?? [];

      return fixtures.timedWithEnd ?? [];
    })();

    const rows = bucket.filter(
      (task) =>
        (!excluded || task.id !== excluded) &&
        (!dropsCompleted || task.completedAt === null),
    );

    return Promise.resolve(rows);
  });

/**
 * Builds a calendar-database stub. By default the single calendar `cal-1` is
 * owned by `user-1`.
 */
const buildCalendarDatabaseService = () => ({
  findOneBy: jest
    .fn()
    .mockResolvedValue({ id: 'cal-1', ownerId: 'user-1' } as Calendar),
  findAllByOwner: jest
    .fn()
    .mockResolvedValue([{ id: 'cal-1', ownerId: 'user-1' } as Calendar]),
});

/**
 * Builds a task-group-database stub.
 */
const buildGroupDatabaseService = () => ({
  findOneBy: jest.fn().mockResolvedValue(null),
});

/**
 * Builds a task-occurrence-exception service stub (no exceptions by default).
 */
const buildExceptionService = () => ({
  findForTask: jest.fn().mockResolvedValue([] as TaskOccurrenceException[]),
  upsertOverride: jest.fn().mockResolvedValue({} as TaskOccurrenceException),
});

const WINDOW_FROM = zoned('2026-06-01T00:00');
const WINDOW_TO = zoned('2026-06-08T00:00');

describe('TaskService.findOccurrencesInRange', () => {
  /**
   * Wires a TaskService with the REAL recurrence engine (pure) so expansion is
   * asserted end-to-end, and a routed task-database mock for the candidate reads.
   */
  const buildService = (
    fixtures: RangeFixtures,
    exceptionService = buildExceptionService(),
  ) => {
    const taskDb = { findAll: routedFindAll(fixtures) };
    const calendarDb = buildCalendarDatabaseService();
    const realEngine = new RecurrenceRuleService(null as never);
    const service = new TaskService(
      taskDb as never,
      calendarDb as never,
      buildGroupDatabaseService() as never,
      realEngine as never,
      exceptionService as never,
    );

    return { service, exceptionService };
  };

  it('rejects an empty window', async () => {
    const { service } = buildService({});

    await expect(
      service.findOccurrencesInRange('user-1', WINDOW_TO, WINDOW_FROM),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('wraps one-off tasks as single occurrences (isRecurring false)', async () => {
    const oneOff = makeTask({
      id: 't-oneoff',
      startAt: zoned('2026-06-03T09:00'),
      endAt: zoned('2026-06-03T10:00'),
    });
    const { service } = buildService({ timedWithEnd: [oneOff] });

    const result = await service.findOccurrencesInRange(
      'user-1',
      WINDOW_FROM,
      WINDOW_TO,
    );

    expect(result).toHaveLength(1);
    expect(result[0].isRecurring).toBe(false);
    expect(result[0].originalStart).toEqual(oneOff.startAt);
    expect(result[0].occurrenceStart).toEqual(oneOff.startAt);
    expect(result[0].occurrenceEnd).toEqual(oneOff.endAt);
  });

  it('expands a recurring anchor across the window', async () => {
    const anchor = makeTask({
      id: 't-weekly',
      startAt: zoned('2026-06-01T09:00'),
      endAt: zoned('2026-06-01T09:30'),
      recurrenceRuleId: 'rule-1',
      recurrenceRule: makeRule({ frequency: RecurrenceFrequency.DAILY }),
    });
    const { service } = buildService({ recurring: [anchor] });

    const result = await service.findOccurrencesInRange(
      'user-1',
      WINDOW_FROM,
      WINDOW_TO,
    );

    expect(result.map((occ) => localDate(occ.occurrenceStart))).toEqual([
      '2026-06-01',
      '2026-06-02',
      '2026-06-03',
      '2026-06-04',
      '2026-06-05',
      '2026-06-06',
      '2026-06-07',
    ]);
    expect(result.every((occ) => occ.isRecurring)).toBe(true);
  });

  it('merges one-offs and recurring occurrences sorted by occurrenceStart', async () => {
    const oneOff = makeTask({
      id: 't-oneoff',
      title: 'One-off',
      startAt: zoned('2026-06-02T12:00'),
      endAt: zoned('2026-06-02T13:00'),
    });
    const anchor = makeTask({
      id: 't-weekly',
      title: 'Daily 9am',
      startAt: zoned('2026-06-01T09:00'),
      endAt: zoned('2026-06-01T09:30'),
      recurrenceRuleId: 'rule-1',
      recurrenceRule: makeRule({ frequency: RecurrenceFrequency.DAILY }),
    });
    const { service } = buildService({
      timedWithEnd: [oneOff],
      recurring: [anchor],
    });

    const result = await service.findOccurrencesInRange(
      'user-1',
      WINDOW_FROM,
      zoned('2026-06-04T00:00'),
    );

    // Daily 6/1, 6/2 (09:00), the one-off 6/2 (12:00), then daily 6/3.
    expect(
      result.map((occ) => [
        localDate(occ.occurrenceStart),
        (occ.occurrenceStart as Date).getTime(),
      ]),
    ).toEqual(
      [
        anchor.startAt,
        zoned('2026-06-02T09:00'),
        oneOff.startAt,
        zoned('2026-06-03T09:00'),
      ].map((date) => [localDate(date), (date as Date).getTime()]),
    );
  });

  it('reflects an exception skip and an override from the engine', async () => {
    const anchor = makeTask({
      id: 't-weekly',
      startAt: zoned('2026-06-01T09:00'),
      endAt: zoned('2026-06-01T09:30'),
      recurrenceRuleId: 'rule-1',
      recurrenceRule: makeRule({ frequency: RecurrenceFrequency.DAILY }),
    });
    const exceptionService = buildExceptionService();

    exceptionService.findForTask.mockResolvedValue([
      {
        id: 'skip',
        taskId: 't-weekly',
        originalStartAt: zoned('2026-06-02T09:00'),
        isSkipped: true,
        overrideStartAt: null,
        overrideEndAt: null,
        overrideTitle: null,
        completedAt: null,
      },
      {
        id: 'moved',
        taskId: 't-weekly',
        originalStartAt: zoned('2026-06-03T09:00'),
        isSkipped: false,
        overrideStartAt: zoned('2026-06-03T15:00'),
        overrideEndAt: zoned('2026-06-03T16:00'),
        overrideTitle: 'Moved',
        completedAt: null,
      },
    ] as TaskOccurrenceException[]);

    const { service } = buildService({ recurring: [anchor] }, exceptionService);

    const result = await service.findOccurrencesInRange(
      'user-1',
      WINDOW_FROM,
      zoned('2026-06-04T00:00'),
    );

    // 6/2 is skipped; 6/3 is moved to 15:00 and renamed.
    expect(result.map((occ) => localDate(occ.occurrenceStart))).toEqual([
      '2026-06-01',
      '2026-06-03',
    ]);

    const moved = result.find((occ) => occ.isException);

    expect(moved?.occurrenceStart).toEqual(zoned('2026-06-03T15:00'));
    expect(moved?.title).toBe('Moved');
  });

  it('drops completed instances unless includeCompleted is set', async () => {
    const completedOneOff = makeTask({
      id: 't-done',
      startAt: zoned('2026-06-02T09:00'),
      endAt: zoned('2026-06-02T10:00'),
      completedAt: zoned('2026-06-02T10:05'),
    });
    const openOneOff = makeTask({
      id: 't-open',
      startAt: zoned('2026-06-03T09:00'),
      endAt: zoned('2026-06-03T10:00'),
    });

    const fixtures = { timedWithEnd: [completedOneOff, openOneOff] };

    const { service } = buildService(fixtures);
    const withoutCompleted = await service.findOccurrencesInRange(
      'user-1',
      WINDOW_FROM,
      WINDOW_TO,
    );

    expect(withoutCompleted.map((occ) => occ.task.id)).toEqual(['t-open']);

    const { service: service2 } = buildService(fixtures);
    const withCompleted = await service2.findOccurrencesInRange(
      'user-1',
      WINDOW_FROM,
      WINDOW_TO,
      { includeCompleted: true },
    );

    expect(withCompleted.map((occ) => occ.task.id).sort()).toEqual([
      't-done',
      't-open',
    ]);
  });

  it('includes timeless todos only when includeTodos is set', async () => {
    const todo = makeTask({ id: 't-todo', title: 'Buy milk', startAt: null });
    const fixtures = { todos: [todo] };

    const { service } = buildService(fixtures);
    const withoutTodos = await service.findOccurrencesInRange(
      'user-1',
      WINDOW_FROM,
      WINDOW_TO,
    );

    expect(withoutTodos).toHaveLength(0);

    const { service: service2 } = buildService(fixtures);
    const withTodos = await service2.findOccurrencesInRange(
      'user-1',
      WINDOW_FROM,
      WINDOW_TO,
      { includeTodos: true },
    );

    expect(withTodos).toHaveLength(1);
    expect(withTodos[0].task.id).toBe('t-todo');
    expect(withTodos[0].occurrenceStart).toBeNull();
    expect(withTodos[0].originalStart).toBeNull();
    expect(withTodos[0].occurrenceEnd).toBeNull();
  });

  it('sorts a timeless todo after timed occurrences', async () => {
    const timed = makeTask({
      id: 't-timed',
      startAt: zoned('2026-06-03T09:00'),
      endAt: zoned('2026-06-03T10:00'),
    });
    const todo = makeTask({ id: 't-todo', title: 'Buy milk', startAt: null });
    const { service } = buildService({
      timedWithEnd: [timed],
      todos: [todo],
    });

    const result = await service.findOccurrencesInRange(
      'user-1',
      WINDOW_FROM,
      WINDOW_TO,
      { includeTodos: true },
    );

    // The null-start todo sorts last, behind every timed occurrence.
    expect(result.map((occ) => occ.task.id)).toEqual(['t-timed', 't-todo']);
    expect(result[result.length - 1].occurrenceStart).toBeNull();
  });
});

describe('TaskService.create', () => {
  /**
   * Builds a TaskService with fully mocked collaborators for the write paths.
   */
  const buildService = () => {
    const taskDb = {
      createInstance: jest.fn((partial: Partial<Task>) => ({ ...partial })),
      save: jest.fn((entity: Task) =>
        Promise.resolve({ ...entity, id: entity.id ?? 'task-1' }),
      ),
    };
    const calendarDb = buildCalendarDatabaseService();
    const groupDb = buildGroupDatabaseService();
    const recurrenceRuleService = {
      create: jest.fn().mockResolvedValue(makeRule({ id: 'rule-1' })),
      update: jest.fn(),
      remove: jest.fn(),
    };
    const exceptionService = buildExceptionService();
    const service = new TaskService(
      taskDb as never,
      calendarDb as never,
      groupDb as never,
      recurrenceRuleService as never,
      exceptionService as never,
    );

    return { service, taskDb, calendarDb, groupDb, recurrenceRuleService };
  };

  it('creates ONE rule and ONE task for a recurring task (never N rows)', async () => {
    const { service, taskDb, recurrenceRuleService } = buildService();

    const result = await service.create('user-1', {
      calendarId: 'cal-1',
      title: 'Standup',
      timezone: 'America/New_York',
      startAt: '2026-06-01T13:00:00.000Z',
      recurrence: { frequency: RecurrenceFrequency.DAILY },
    });

    expect(recurrenceRuleService.create).toHaveBeenCalledTimes(1);
    expect(taskDb.save).toHaveBeenCalledTimes(1);
    expect(taskDb.createInstance).toHaveBeenCalledWith(
      expect.objectContaining({ recurrenceRuleId: 'rule-1' }),
    );
    expect(result.recurrenceRuleId).toBe('rule-1');
  });

  it('rejects a recurring task without an anchor startAt', async () => {
    const { service, recurrenceRuleService } = buildService();

    await expect(
      service.create('user-1', {
        calendarId: 'cal-1',
        title: 'No anchor',
        timezone: 'America/New_York',
        recurrence: { frequency: RecurrenceFrequency.DAILY },
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(recurrenceRuleService.create).not.toHaveBeenCalled();
  });

  it('creates a todo (no times) as a first-class path', async () => {
    const { service, taskDb } = buildService();

    await service.create('user-1', {
      calendarId: 'cal-1',
      title: 'Buy milk',
      timezone: 'America/New_York',
    });

    expect(taskDb.createInstance).toHaveBeenCalledWith(
      expect.objectContaining({
        startAt: null,
        endAt: null,
        recurrenceRuleId: null,
        requiresCompletion: true,
      }),
    );
  });

  it('accepts a groupId that lives in the same calendar', async () => {
    const { service, taskDb, groupDb } = buildService();

    groupDb.findOneBy.mockResolvedValue({ id: 'group-1', calendarId: 'cal-1' });

    await service.create('user-1', {
      calendarId: 'cal-1',
      title: 'Grouped',
      timezone: 'America/New_York',
      groupId: 'group-1',
    });

    expect(taskDb.createInstance).toHaveBeenCalledWith(
      expect.objectContaining({ groupId: 'group-1' }),
    );
  });

  it('rejects a groupId that belongs to a different calendar', async () => {
    const { service, groupDb } = buildService();

    groupDb.findOneBy.mockResolvedValue({
      id: 'group-1',
      calendarId: 'other-cal',
    });

    await expect(
      service.create('user-1', {
        calendarId: 'cal-1',
        title: 'Mismatched group',
        timezone: 'America/New_York',
        groupId: 'group-1',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('TaskService recurring-edit scopes', () => {
  /**
   * Builds a TaskService with mocked collaborators and a loaded task fixture for
   * the edit-scope operations.
   */
  const buildService = (task: Task) => {
    const taskDb = {
      findOneBy: jest.fn().mockResolvedValue(task),
      // `applyOccurrenceOverride`'s membership guard re-loads the anchor with its
      // `recurrenceRule` relation via `findOne`; the fixture already carries it.
      findOne: jest.fn().mockResolvedValue(task),
      createInstance: jest.fn((partial: Partial<Task>) => ({ ...partial })),
      save: jest.fn((entity: Task) =>
        Promise.resolve({ ...entity, id: entity.id ?? 'new-task' }),
      ),
    };
    const calendarDb = buildCalendarDatabaseService();
    const recurrenceRuleService = {
      create: jest.fn().mockResolvedValue(makeRule({ id: 'rule-2' })),
      update: jest.fn().mockResolvedValue(makeRule()),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    const exceptionService = buildExceptionService();
    const service = new TaskService(
      taskDb as never,
      calendarDb as never,
      buildGroupDatabaseService() as never,
      recurrenceRuleService as never,
      exceptionService as never,
    );

    return { service, taskDb, recurrenceRuleService, exceptionService };
  };

  describe('applyOccurrenceOverride', () => {
    it('upserts a skip exception for a recurring task (delete-one)', async () => {
      const task = makeTask({ recurrenceRuleId: 'rule-1' });
      const { service, exceptionService } = buildService(task);
      const originalStart = zoned('2026-06-02T09:00');

      await service.applyOccurrenceOverride('user-1', 'task-1', originalStart, {
        isSkipped: true,
      });

      expect(exceptionService.upsertOverride).toHaveBeenCalledWith(
        'task-1',
        originalStart,
        { isSkipped: true },
      );
    });

    it('collapses to a soft-delete for a non-recurring task skip', async () => {
      const task = makeTask({ recurrenceRuleId: null });
      const { service, taskDb, exceptionService } = buildService(task);

      await service.applyOccurrenceOverride(
        'user-1',
        'task-1',
        zoned('2026-06-02T09:00'),
        { isSkipped: true },
      );

      expect(exceptionService.upsertOverride).not.toHaveBeenCalled();
      // Soft-delete stamps deletedAt and saves.
      expect(taskDb.save).toHaveBeenCalledTimes(1);
      expect(task.deletedAt).toBeInstanceOf(Date);
    });

    /**
     * Wires a TaskService with the REAL recurrence engine so the override
     * membership guard (Fix 3) runs its tight-window expansion for real. The
     * anchor is a daily 09:00 series; `findOne` re-loads it with its rule.
     */
    const buildGuardedService = (
      anchor: Task,
      exceptionService = buildExceptionService(),
    ) => {
      const taskDb = {
        findOneBy: jest.fn().mockResolvedValue(anchor),
        findOne: jest.fn().mockResolvedValue(anchor),
        createInstance: jest.fn((partial: Partial<Task>) => ({ ...partial })),
        save: jest.fn((entity: Task) => Promise.resolve({ ...entity })),
      };
      const service = new TaskService(
        taskDb as never,
        buildCalendarDatabaseService() as never,
        buildGroupDatabaseService() as never,
        new RecurrenceRuleService(null as never) as never,
        exceptionService as never,
      );

      return { service, exceptionService };
    };

    const dailyAnchor = () =>
      makeTask({
        recurrenceRuleId: 'rule-1',
        recurrenceRule: makeRule({ frequency: RecurrenceFrequency.DAILY }),
        startAt: zoned('2026-06-01T09:00'),
        endAt: zoned('2026-06-01T09:30'),
        title: 'Standup',
      });

    it('allows an override on a real generated occurrence (Fix 3)', async () => {
      const { service, exceptionService } = buildGuardedService(dailyAnchor());
      const validStart = zoned('2026-06-04T09:00'); // a real daily instance

      await service.applyOccurrenceOverride('user-1', 'task-1', validStart, {
        overrideTitle: 'Standup (moved)',
      });

      expect(exceptionService.upsertOverride).toHaveBeenCalledWith(
        'task-1',
        validStart,
        { overrideTitle: 'Standup (moved)' },
      );
    });

    it('throws on a bogus originalStart for an override (Fix 3)', async () => {
      const { service, exceptionService } = buildGuardedService(dailyAnchor());
      // 11:33 is not a daily-09:00 instant — the rule never generates it.
      const bogusStart = zoned('2026-06-04T11:33');

      await expect(
        service.applyOccurrenceOverride('user-1', 'task-1', bogusStart, {
          overrideStartAt: zoned('2026-06-04T12:00'),
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(exceptionService.upsertOverride).not.toHaveBeenCalled();
    });

    it('stays lenient for a skip on an arbitrary originalStart (Fix 3)', async () => {
      const { service, exceptionService } = buildGuardedService(dailyAnchor());
      const bogusStart = zoned('2026-06-04T11:33');

      // A pure skip is not an override mutation — no membership guard.
      await service.applyOccurrenceOverride('user-1', 'task-1', bogusStart, {
        isSkipped: true,
      });

      expect(exceptionService.upsertOverride).toHaveBeenCalledWith(
        'task-1',
        bogusStart,
        { isSkipped: true },
      );
    });

    it('stays lenient for a completion-only change on an arbitrary originalStart (Fix 3)', async () => {
      const { service, exceptionService } = buildGuardedService(dailyAnchor());
      const bogusStart = zoned('2026-06-04T11:33');

      await service.applyOccurrenceOverride('user-1', 'task-1', bogusStart, {
        completedAt: zoned('2026-06-04T12:00'),
      });

      expect(exceptionService.upsertOverride).toHaveBeenCalledTimes(1);
    });
  });

  describe('setOccurrenceCompleted', () => {
    it('writes a per-instance completedAt for a recurring task', async () => {
      const task = makeTask({ recurrenceRuleId: 'rule-1' });
      const { service, exceptionService } = buildService(task);
      const originalStart = zoned('2026-06-02T09:00');

      await service.setOccurrenceCompleted(
        'user-1',
        'task-1',
        originalStart,
        true,
      );

      expect(exceptionService.upsertOverride).toHaveBeenCalledTimes(1);

      const [taskIdArg, startArg, changes] =
        exceptionService.upsertOverride.mock.calls[0];

      expect(taskIdArg).toBe('task-1');
      expect(startArg).toBe(originalStart);
      expect(changes.completedAt).toBeInstanceOf(Date);
    });

    it('clears a per-instance completion with null when completed=false', async () => {
      const task = makeTask({ recurrenceRuleId: 'rule-1' });
      const { service, exceptionService } = buildService(task);

      await service.setOccurrenceCompleted(
        'user-1',
        'task-1',
        zoned('2026-06-02T09:00'),
        false,
      );

      expect(exceptionService.upsertOverride.mock.calls[0][2]).toEqual({
        completedAt: null,
      });
    });

    it('collapses to master setCompleted for a non-recurring task', async () => {
      const task = makeTask({ recurrenceRuleId: null, completedAt: null });
      const { service, taskDb, exceptionService } = buildService(task);

      await service.setOccurrenceCompleted(
        'user-1',
        'task-1',
        zoned('2026-06-02T09:00'),
        true,
      );

      expect(exceptionService.upsertOverride).not.toHaveBeenCalled();
      expect(taskDb.save).toHaveBeenCalledTimes(1);
      expect(task.completedAt).toBeInstanceOf(Date);
    });

    it('returns the persisted exception completedAt with isOccurrenceScoped true', async () => {
      const task = makeTask({ recurrenceRuleId: 'rule-1' });
      const persistedAt = zoned('2026-06-02T10:05');
      const exceptionService = buildExceptionService();

      exceptionService.upsertOverride.mockResolvedValue({
        completedAt: persistedAt,
      } as TaskOccurrenceException);

      const taskDb = {
        findOneBy: jest.fn().mockResolvedValue(task),
        findOne: jest.fn().mockResolvedValue(task),
        createInstance: jest.fn(),
        save: jest.fn(),
      };
      const service = new TaskService(
        taskDb as never,
        buildCalendarDatabaseService() as never,
        buildGroupDatabaseService() as never,
        {} as never,
        exceptionService as never,
      );

      const result = await service.setOccurrenceCompleted(
        'user-1',
        'task-1',
        zoned('2026-06-02T09:00'),
        true,
      );

      expect(result).toEqual({
        completedAt: persistedAt,
        isOccurrenceScoped: true,
      });
    });

    it('returns the master completedAt with isOccurrenceScoped false for a non-recurring task', async () => {
      const task = makeTask({ recurrenceRuleId: null, completedAt: null });
      const { service } = buildService(task);

      const result = await service.setOccurrenceCompleted(
        'user-1',
        'task-1',
        zoned('2026-06-02T09:00'),
        true,
      );

      expect(result.isOccurrenceScoped).toBe(false);
      expect(result.completedAt).toBeInstanceOf(Date);
      // Matches what the master row now carries.
      expect(result.completedAt).toBe(task.completedAt);
    });
  });

  describe('splitSeries', () => {
    it('short-circuits to a master update when originalStart equals the series start', async () => {
      const seriesStart = zoned('2026-06-01T09:00');
      const task = makeTask({
        recurrenceRuleId: 'rule-1',
        recurrenceRule: makeRule(),
        startAt: seriesStart,
        endAt: zoned('2026-06-01T09:30'),
      });
      const { service, taskDb, recurrenceRuleService } = buildService(task);

      await service.splitSeries('user-1', 'task-1', seriesStart, {
        title: 'Renamed all',
      });

      // No new rule, no new anchor — this IS "all".
      expect(recurrenceRuleService.create).not.toHaveBeenCalled();
      expect(taskDb.createInstance).not.toHaveBeenCalled();
      expect(task.title).toBe('Renamed all');
      expect(taskDb.save).toHaveBeenCalledTimes(1);
    });

    it('ends the old rule, creates a new rule + anchor, and copies forward exceptions', async () => {
      const task = makeTask({
        recurrenceRuleId: 'rule-1',
        recurrenceRule: makeRule({ frequency: RecurrenceFrequency.DAILY }),
        startAt: zoned('2026-06-01T09:00'),
        endAt: zoned('2026-06-01T09:30'),
      });
      const { service, taskDb, recurrenceRuleService, exceptionService } =
        buildService(task);

      exceptionService.findForTask.mockResolvedValue([
        {
          id: 'before',
          taskId: 'task-1',
          originalStartAt: zoned('2026-06-02T09:00'),
          isSkipped: true,
          overrideStartAt: null,
          overrideEndAt: null,
          overrideTitle: null,
          completedAt: null,
        },
        {
          id: 'after',
          taskId: 'task-1',
          originalStartAt: zoned('2026-06-10T09:00'),
          isSkipped: false,
          overrideStartAt: null,
          overrideEndAt: null,
          overrideTitle: 'Kept',
          completedAt: null,
        },
      ] as TaskOccurrenceException[]);

      const splitAt = zoned('2026-06-05T09:00');
      const newTask = await service.splitSeries('user-1', 'task-1', splitAt, {
        title: 'New chapter',
      });

      // Old rule ended the day before the split.
      expect(recurrenceRuleService.update).toHaveBeenCalledWith('rule-1', {
        endType: RecurrenceEndType.UNTIL_DATE,
        endDate: '2026-06-04',
      });
      // A new rule + a new anchor task were created.
      expect(recurrenceRuleService.create).toHaveBeenCalledTimes(1);
      expect(taskDb.createInstance).toHaveBeenCalledWith(
        expect.objectContaining({
          recurrenceRuleId: 'rule-2',
          title: 'New chapter',
          startAt: splitAt,
        }),
      );
      expect(newTask.recurrenceRuleId).toBe('rule-2');

      // Only the exception dated >= split is copied onto the new task.
      expect(exceptionService.upsertOverride).toHaveBeenCalledTimes(1);
      expect(exceptionService.upsertOverride).toHaveBeenCalledWith(
        'new-task',
        zoned('2026-06-10T09:00'),
        expect.objectContaining({ overrideTitle: 'Kept' }),
      );
    });

    it('preserves the anchor duration on the new series when endAt is not overridden', async () => {
      const task = makeTask({
        recurrenceRuleId: 'rule-1',
        recurrenceRule: makeRule({ frequency: RecurrenceFrequency.DAILY }),
        startAt: zoned('2026-06-01T09:00'),
        endAt: zoned('2026-06-01T10:00'), // 1h duration
      });
      const { service, taskDb } = buildService(task);
      const splitAt = zoned('2026-06-05T09:00');

      await service.splitSeries('user-1', 'task-1', splitAt, {});

      const created = taskDb.createInstance.mock.calls[0][0];
      const durationMillis =
        (created.endAt as Date).getTime() - (created.startAt as Date).getTime();

      expect(durationMillis).toBe(60 * 60 * 1000);
    });

    it('collapses to a plain update for a non-recurring task', async () => {
      const task = makeTask({ recurrenceRuleId: null });
      const { service, taskDb, recurrenceRuleService } = buildService(task);

      await service.splitSeries('user-1', 'task-1', zoned('2026-06-05T09:00'), {
        title: 'Renamed',
      });

      expect(recurrenceRuleService.create).not.toHaveBeenCalled();
      expect(taskDb.createInstance).not.toHaveBeenCalled();
      expect(task.title).toBe('Renamed');
      expect(taskDb.save).toHaveBeenCalledTimes(1);
    });
  });
});

describe('TaskService.update (details scope)', () => {
  /**
   * Builds a TaskService over a single mutable task fixture, with mocked
   * collaborators for the details-update path.
   */
  const buildService = (task: Task) => {
    const taskDb = {
      findOneBy: jest.fn().mockResolvedValue(task),
      save: jest.fn((entity: Task) => Promise.resolve(entity)),
    };
    const recurrenceRuleService = {
      create: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
    };
    const service = new TaskService(
      taskDb as never,
      buildCalendarDatabaseService() as never,
      buildGroupDatabaseService() as never,
      recurrenceRuleService as never,
      buildExceptionService() as never,
    );

    return { service, taskDb };
  };

  it('applies isAllDay and requiresCompletion', async () => {
    const task = makeTask({
      id: 'task-1',
      isAllDay: false,
      requiresCompletion: true,
    });
    const { service, taskDb } = buildService(task);

    const result = await service.update('user-1', 'task-1', {
      isAllDay: true,
      requiresCompletion: false,
    });

    expect(result.isAllDay).toBe(true);
    expect(result.requiresCompletion).toBe(false);
    expect(taskDb.save).toHaveBeenCalledTimes(1);
  });

  it('leaves isAllDay and requiresCompletion untouched when omitted', async () => {
    const task = makeTask({
      id: 'task-1',
      title: 'Old',
      isAllDay: true,
      requiresCompletion: false,
    });
    const { service } = buildService(task);

    const result = await service.update('user-1', 'task-1', { title: 'New' });

    expect(result.title).toBe('New');
    // Unchanged because the keys were not provided.
    expect(result.isAllDay).toBe(true);
    expect(result.requiresCompletion).toBe(false);
  });

  it('short-circuits without saving when an isAllDay toggle is a no-op', async () => {
    const task = makeTask({ id: 'task-1', isAllDay: true });
    const { service, taskDb } = buildService(task);

    // Same value as current — no field actually changes.
    await service.update('user-1', 'task-1', { isAllDay: true });

    expect(taskDb.save).not.toHaveBeenCalled();
  });

  it('saves when only requiresCompletion changes (diff includes it)', async () => {
    const task = makeTask({ id: 'task-1', requiresCompletion: true });
    const { service, taskDb } = buildService(task);

    await service.update('user-1', 'task-1', { requiresCompletion: false });

    expect(taskDb.save).toHaveBeenCalledTimes(1);
    expect(task.requiresCompletion).toBe(false);
  });
});

describe('TaskService.findOverlapping (occurrence-aware)', () => {
  /**
   * Builds a TaskService whose task-database routes one-off vs recurring reads,
   * backed by the real recurrence engine for expansion.
   */
  const buildService = (
    fixtures: RangeFixtures,
    exceptionService = buildExceptionService(),
  ) => {
    const taskDb = { findAll: routedFindAll(fixtures) };
    const calendarDb = buildCalendarDatabaseService();
    const realEngine = new RecurrenceRuleService(null as never);
    const service = new TaskService(
      taskDb as never,
      calendarDb as never,
      buildGroupDatabaseService() as never,
      realEngine as never,
      exceptionService as never,
    );

    return { service };
  };

  it('flags a recurring series whose expanded occurrence overlaps the window', async () => {
    // A daily 09:00–09:30 series anchored weeks earlier; the target window is a
    // single day at 09:15, which the in-window expansion overlaps.
    const anchor = makeTask({
      id: 't-daily',
      title: 'Daily standup',
      startAt: zoned('2026-05-01T09:00'),
      endAt: zoned('2026-05-01T09:30'),
      recurrenceRuleId: 'rule-1',
      recurrenceRule: makeRule({ frequency: RecurrenceFrequency.DAILY }),
    });
    const { service } = buildService({ recurring: [anchor] });

    const clashes = await service.findOverlapping(
      'user-1',
      'cal-1',
      zoned('2026-06-03T09:15'),
      zoned('2026-06-03T09:45'),
    );

    expect(clashes.map((task) => task.id)).toEqual(['t-daily']);
    expect(clashes[0].title).toBe('Daily standup');
  });

  it('does not flag a recurring series that has no occurrence in the window', async () => {
    // A weekly Monday series; the target window is a Wednesday — no clash.
    const anchor = makeTask({
      id: 't-weekly',
      startAt: zoned('2026-06-01T09:00'), // Monday
      endAt: zoned('2026-06-01T09:30'),
      recurrenceRuleId: 'rule-1',
      recurrenceRule: makeRule({ frequency: RecurrenceFrequency.WEEKLY }),
    });
    const { service } = buildService({ recurring: [anchor] });

    const clashes = await service.findOverlapping(
      'user-1',
      'cal-1',
      zoned('2026-06-03T09:15'), // Wednesday
      zoned('2026-06-03T09:45'),
    );

    expect(clashes).toHaveLength(0);
  });

  it('excludes the task being edited from the clash set', async () => {
    const anchor = makeTask({
      id: 't-daily',
      startAt: zoned('2026-05-01T09:00'),
      endAt: zoned('2026-05-01T09:30'),
      recurrenceRuleId: 'rule-1',
      recurrenceRule: makeRule({ frequency: RecurrenceFrequency.DAILY }),
    });
    const { service } = buildService({ recurring: [anchor] });

    const clashes = await service.findOverlapping(
      'user-1',
      'cal-1',
      zoned('2026-06-03T09:15'),
      zoned('2026-06-03T09:45'),
      't-daily',
    );

    expect(clashes).toHaveLength(0);
  });

  it('returns one-off timed overlaps from the direct query', async () => {
    const oneOff = makeTask({
      id: 't-oneoff',
      title: 'Lunch',
      startAt: zoned('2026-06-03T12:00'),
      endAt: zoned('2026-06-03T13:00'),
    });
    const { service } = buildService({ timedWithEnd: [oneOff] });

    const clashes = await service.findOverlapping(
      'user-1',
      'cal-1',
      zoned('2026-06-03T12:30'),
      zoned('2026-06-03T12:45'),
    );

    expect(clashes.map((task) => task.id)).toEqual(['t-oneoff']);
  });

  it('flags an end-less one-off whose startAt falls inside the window (Fix 1)', async () => {
    // A point / all-day-without-end event: endAt IS NULL, startAt within the
    // proposed [startAt, endAt). Previously never returned (false negative).
    const noEnd = makeTask({
      id: 't-noend',
      title: 'All-day, no end',
      startAt: zoned('2026-06-03T12:30'),
      endAt: null,
    });
    const taskDb = { findAll: routedFindAll({ timedNoEnd: [noEnd] }) };
    const service = new TaskService(
      taskDb as never,
      buildCalendarDatabaseService() as never,
      buildGroupDatabaseService() as never,
      new RecurrenceRuleService(null as never) as never,
      buildExceptionService() as never,
    );

    const clashes = await service.findOverlapping(
      'user-1',
      'cal-1',
      zoned('2026-06-03T12:00'),
      zoned('2026-06-03T13:00'),
    );

    expect(clashes.map((task) => task.id)).toEqual(['t-noend']);

    // The no-end branch queries `endAt IS NULL` over a ranged `startAt`,
    // mirroring the `timedNoEnd` bucket of findOccurrencesInRange.
    const noEndCall = taskDb.findAll.mock.calls
      .map((call) => (call[0]?.where ?? {}) as FindOptionsWhere<Task>)
      .find((where) => operatorType(where.endAt) === 'isNull');

    expect(noEndCall).toBeDefined();
    expect(operatorType((noEndCall as FindOptionsWhere<Task>).startAt)).toBe(
      'and',
    );
    expect(
      operatorType((noEndCall as FindOptionsWhere<Task>).completedAt),
    ).toBe('isNull');
  });

  it('does not flag a completed one-off as a live conflict (Fix 2)', async () => {
    const completed = makeTask({
      id: 't-done',
      title: 'Finished lunch',
      startAt: zoned('2026-06-03T12:00'),
      endAt: zoned('2026-06-03T13:00'),
      completedAt: zoned('2026-06-03T13:05'),
    });
    const open = makeTask({
      id: 't-open',
      title: 'Open lunch',
      startAt: zoned('2026-06-03T12:00'),
      endAt: zoned('2026-06-03T13:00'),
    });
    const { service } = buildService({ timedWithEnd: [completed, open] });

    const clashes = await service.findOverlapping(
      'user-1',
      'cal-1',
      zoned('2026-06-03T12:30'),
      zoned('2026-06-03T12:45'),
    );

    // Only the open event clashes; the completed one is dropped.
    expect(clashes.map((task) => task.id)).toEqual(['t-open']);
  });

  it('does not flag a recurring occurrence completed per-instance (Fix 2)', async () => {
    const anchor = makeTask({
      id: 't-daily',
      title: 'Daily standup',
      startAt: zoned('2026-05-01T09:00'),
      endAt: zoned('2026-05-01T09:30'),
      recurrenceRuleId: 'rule-1',
      recurrenceRule: makeRule({ frequency: RecurrenceFrequency.DAILY }),
    });
    const exceptionService = buildExceptionService();

    // The 2026-06-03 occurrence is marked complete via a per-instance exception.
    exceptionService.findForTask.mockResolvedValue([
      {
        id: 'done',
        taskId: 't-daily',
        originalStartAt: zoned('2026-06-03T09:00'),
        isSkipped: false,
        overrideStartAt: null,
        overrideEndAt: null,
        overrideTitle: null,
        completedAt: zoned('2026-06-03T09:35'),
      },
    ] as TaskOccurrenceException[]);

    const { service } = buildService({ recurring: [anchor] }, exceptionService);

    const clashes = await service.findOverlapping(
      'user-1',
      'cal-1',
      zoned('2026-06-03T09:15'),
      zoned('2026-06-03T09:45'),
    );

    expect(clashes).toHaveLength(0);
  });
});

/**
 * A Map-backed fake of the recurrence-rule database service. It mints ids on
 * save and returns the SAME mutable rule object from finds, so a `.update()`
 * applied by the engine is observable when the test re-expands the rule. This
 * lets `splitSeries` run against the REAL expansion engine end-to-end (its CRUD
 * lands here) instead of a hand-populated mock that masks relation/COUNT bugs.
 */
const buildFakeRecurrenceDb = (seedRules: RecurrenceRule[] = []) => {
  const store = new Map<string, RecurrenceRule>();
  let sequence = 0;

  for (const rule of seedRules) store.set(rule.id, rule);

  return {
    store,
    createInstance: jest.fn((partial: Partial<RecurrenceRule>) => ({
      ...partial,
    })),
    save: jest.fn((rule: RecurrenceRule) => {
      const withId = rule.id ? rule : { ...rule, id: `rule-new-${++sequence}` };

      store.set(withId.id, withId);

      return Promise.resolve(withId);
    }),
    findOneByOrThrow: jest.fn(({ id }: { id: string }) => {
      const rule = store.get(id);

      if (!rule) throw new Error(`rule ${id} not found`);

      return Promise.resolve(rule);
    }),
    deleteOrThrow: jest.fn((id: string) => {
      store.delete(id);

      return Promise.resolve({ affected: 1 });
    }),
  };
};

/**
 * Expands a rule via the real engine using a throwaway anchor carrying the given
 * start/duration, returning the generated `originalStart` epoch-millis in order.
 */
const expandStarts = (
  engine: RecurrenceRuleService,
  rule: RecurrenceRule,
  startAt: Date,
  durationMs: number,
  from: Date,
  to: Date,
): number[] => {
  const anchor = makeTask({
    startAt,
    endAt: new Date(startAt.getTime() + durationMs),
    recurrenceRuleId: rule.id,
    recurrenceRule: rule,
  });

  return engine
    .expandOccurrences(anchor, rule, [], from, to)
    .map((occurrence) => (occurrence.originalStart as Date).getTime());
};

describe('TaskService.splitSeries (real-engine seam)', () => {
  const WIDE_FROM = zoned('2026-01-01T00:00');
  const WIDE_TO = zoned('2027-01-01T00:00');

  /**
   * Wires a TaskService with the REAL recurrence engine (backed by a Map fake DB
   * so its CRUD works) and a task-database stub whose relation-loaded `findOne`
   * returns the provided anchor. `groupDbOverride` lets a test exercise the
   * cross-calendar group guard.
   */
  const buildSeamService = (
    anchor: Task,
    options: {
      seedRules?: RecurrenceRule[];
      groupDbOverride?: { findOneBy: jest.Mock };
      relationAbsentAnchor?: Task;
    } = {},
  ) => {
    const recurrenceDb = buildFakeRecurrenceDb(
      options.seedRules ??
        (anchor.recurrenceRule ? [anchor.recurrenceRule] : []),
    );
    const engine = new RecurrenceRuleService(recurrenceDb as never);
    const savedTasks: Task[] = [];
    const taskDb = {
      // `findByIdWithRule` reads through `findOne` (relation hydrated). When a
      // test supplies a relation-absent anchor for `findOneBy`, `findOne` still
      // returns the rule-bearing one — mirroring the real ORM (relation only on
      // the relations-eager load), so we can prove the split no longer reads the
      // rule off the relation-less `findById`.
      findOne: jest.fn().mockResolvedValue(anchor),
      findOneBy: jest
        .fn()
        .mockResolvedValue(options.relationAbsentAnchor ?? anchor),
      createInstance: jest.fn((partial: Partial<Task>) => ({ ...partial })),
      save: jest.fn((entity: Task) => {
        const withId = entity.id ? entity : { ...entity, id: 'new-task' };

        savedTasks.push(withId);

        return Promise.resolve(withId);
      }),
    };
    const service = new TaskService(
      taskDb as never,
      buildCalendarDatabaseService() as never,
      (options.groupDbOverride ?? buildGroupDatabaseService()) as never,
      engine as never,
      buildExceptionService() as never,
    );

    return { service, engine, recurrenceDb, taskDb, savedTasks };
  };

  it('does NOT throw when the anchor is loaded without its recurrenceRule relation (C1)', async () => {
    // The series rule exists, but a relation-LESS load (findOneBy) leaves
    // `recurrenceRule` undefined — the exact shape a real `findById` returns.
    // `splitSeries` must hydrate the relation itself and split, not 500.
    const rule = makeRule({
      id: 'rule-1',
      frequency: RecurrenceFrequency.DAILY,
    });
    const relationAbsent = makeTask({
      id: 'task-1',
      startAt: zoned('2026-06-01T09:00'),
      endAt: zoned('2026-06-01T09:30'),
      recurrenceRuleId: 'rule-1',
      recurrenceRule: undefined as never, // relation NOT hydrated
    });
    const hydrated = makeTask({
      ...relationAbsent,
      recurrenceRule: rule,
    });
    const { service, recurrenceDb } = buildSeamService(hydrated, {
      seedRules: [rule],
      relationAbsentAnchor: relationAbsent,
    });

    const splitAt = zoned('2026-06-05T09:00');
    const newMaster = await service.splitSeries(
      'user-1',
      'task-1',
      splitAt,
      {},
    );

    // The old rule was ended and a brand-new rule created — proof the split ran.
    expect(recurrenceDb.findOneByOrThrow).toHaveBeenCalledWith({
      id: 'rule-1',
    });
    expect(newMaster.recurrenceRuleId).toBeDefined();
    expect(newMaster.recurrenceRuleId).not.toBe('rule-1');
  });

  it('leaves no gap and no overlap across a weekly single-weekday split', async () => {
    // Weekly on Monday (the anchor day). Split at a later Monday: old side keeps
    // the earlier Mondays, new side carries the rest — contiguous, disjoint.
    const rule = makeRule({
      id: 'rule-1',
      frequency: RecurrenceFrequency.WEEKLY,
    });
    const anchorStart = zoned('2026-06-01T09:00'); // Monday
    const anchor = makeTask({
      id: 'task-1',
      startAt: anchorStart,
      endAt: zoned('2026-06-01T09:30'),
      recurrenceRuleId: 'rule-1',
      recurrenceRule: rule,
    });
    const { service, engine, recurrenceDb } = buildSeamService(anchor);

    const fullBefore = expandStarts(
      engine,
      rule,
      anchorStart,
      30 * 60_000,
      WIDE_FROM,
      WIDE_TO,
    );

    const splitAt = zoned('2026-06-22T09:00'); // a later Monday in the series
    const newMaster = await service.splitSeries(
      'user-1',
      'task-1',
      splitAt,
      {},
    );

    const oldRule = recurrenceDb.store.get('rule-1') as RecurrenceRule;
    const newRule = recurrenceDb.store.get(
      newMaster.recurrenceRuleId as string,
    ) as RecurrenceRule;

    const oldStarts = expandStarts(
      engine,
      oldRule,
      anchorStart,
      30 * 60_000,
      WIDE_FROM,
      WIDE_TO,
    );
    const newStarts = expandStarts(
      engine,
      newRule,
      newMaster.startAt as Date,
      30 * 60_000,
      WIDE_FROM,
      WIDE_TO,
    );

    // No overlap: every old start is strictly before the split, every new one
    // at/after it.
    expect(oldStarts.every((time) => time < splitAt.getTime())).toBe(true);
    expect(newStarts.every((time) => time >= splitAt.getTime())).toBe(true);
    // No gap: old + new reconstruct exactly the original (windowed) series.
    expect([...oldStarts, ...newStarts]).toEqual(fullBefore);
  });

  it('leaves no gap and no overlap across a multi-weekday split mid-week (byWeekday [0,3])', async () => {
    // Mon + Thu. Anchor is a Monday; split on a Thursday — the split boundary
    // falls mid-week, the trickiest case for the day-before UNTIL cut.
    const rule = makeRule({
      id: 'rule-1',
      frequency: RecurrenceFrequency.WEEKLY,
      byWeekday: [0, 3],
    });
    const anchorStart = zoned('2026-06-01T09:00'); // Monday
    const anchor = makeTask({
      id: 'task-1',
      startAt: anchorStart,
      endAt: zoned('2026-06-01T09:30'),
      recurrenceRuleId: 'rule-1',
      recurrenceRule: rule,
    });
    const { service, engine, recurrenceDb } = buildSeamService(anchor);

    const fullBefore = expandStarts(
      engine,
      rule,
      anchorStart,
      30 * 60_000,
      WIDE_FROM,
      WIDE_TO,
    );

    const splitAt = zoned('2026-06-18T09:00'); // a Thursday in the series
    const newMaster = await service.splitSeries(
      'user-1',
      'task-1',
      splitAt,
      {},
    );

    const oldRule = recurrenceDb.store.get('rule-1') as RecurrenceRule;
    const newRule = recurrenceDb.store.get(
      newMaster.recurrenceRuleId as string,
    ) as RecurrenceRule;
    const oldStarts = expandStarts(
      engine,
      oldRule,
      anchorStart,
      30 * 60_000,
      WIDE_FROM,
      WIDE_TO,
    );
    const newStarts = expandStarts(
      engine,
      newRule,
      newMaster.startAt as Date,
      30 * 60_000,
      WIDE_FROM,
      WIDE_TO,
    );

    // The Monday of the split week stays on the OLD side; the Thursday opens the
    // new side — split boundary lands cleanly between same-week occurrences.
    expect(oldStarts).toContain(zoned('2026-06-15T09:00').getTime()); // Mon
    expect(newStarts[0]).toBe(splitAt.getTime()); // Thu
    expect(oldStarts.every((time) => time < splitAt.getTime())).toBe(true);
    expect(newStarts.every((time) => time >= splitAt.getTime())).toBe(true);
    expect([...oldStarts, ...newStarts]).toEqual(fullBefore);
  });

  it('leaves no gap and no overlap across an UNTIL_DATE split', async () => {
    const rule = makeRule({
      id: 'rule-1',
      frequency: RecurrenceFrequency.DAILY,
      endType: RecurrenceEndType.UNTIL_DATE,
      endDate: '2026-06-30',
    });
    const anchorStart = zoned('2026-06-01T09:00');
    const anchor = makeTask({
      id: 'task-1',
      startAt: anchorStart,
      endAt: zoned('2026-06-01T09:30'),
      recurrenceRuleId: 'rule-1',
      recurrenceRule: rule,
    });
    const { service, engine, recurrenceDb } = buildSeamService(anchor);

    const fullBefore = expandStarts(
      engine,
      rule,
      anchorStart,
      30 * 60_000,
      WIDE_FROM,
      WIDE_TO,
    );

    const splitAt = zoned('2026-06-15T09:00');
    const newMaster = await service.splitSeries(
      'user-1',
      'task-1',
      splitAt,
      {},
    );

    const oldRule = recurrenceDb.store.get('rule-1') as RecurrenceRule;
    const newRule = recurrenceDb.store.get(
      newMaster.recurrenceRuleId as string,
    ) as RecurrenceRule;

    // The new side inherits the original UNTIL date (clone), so the tail ends
    // where the original did — no occurrences invented past 2026-06-30.
    expect(newRule.endType).toBe(RecurrenceEndType.UNTIL_DATE);
    expect(newRule.endDate).toBe('2026-06-30');

    const oldStarts = expandStarts(
      engine,
      oldRule,
      anchorStart,
      30 * 60_000,
      WIDE_FROM,
      WIDE_TO,
    );
    const newStarts = expandStarts(
      engine,
      newRule,
      newMaster.startAt as Date,
      30 * 60_000,
      WIDE_FROM,
      WIDE_TO,
    );

    expect(oldStarts.every((time) => time < splitAt.getTime())).toBe(true);
    expect(newStarts.every((time) => time >= splitAt.getTime())).toBe(true);
    expect([...oldStarts, ...newStarts]).toEqual(fullBefore);
  });

  it('keeps the combined COUNT total equal to the original across the split (C2)', async () => {
    // A COUNT=10 daily series split at the 5th occurrence. The old side keeps 4,
    // the new side must carry 6 — combined 10, never 14.
    const rule = makeRule({
      id: 'rule-1',
      frequency: RecurrenceFrequency.DAILY,
      endType: RecurrenceEndType.COUNT,
      count: 10,
    });
    const anchorStart = zoned('2026-06-01T09:00');
    const anchor = makeTask({
      id: 'task-1',
      startAt: anchorStart,
      endAt: zoned('2026-06-01T09:30'),
      recurrenceRuleId: 'rule-1',
      recurrenceRule: rule,
    });
    const { service, engine, recurrenceDb } = buildSeamService(anchor);

    const fullBefore = expandStarts(
      engine,
      rule,
      anchorStart,
      30 * 60_000,
      WIDE_FROM,
      WIDE_TO,
    );

    expect(fullBefore).toHaveLength(10);

    const splitAt = zoned('2026-06-05T09:00'); // the 5th daily occurrence
    const newMaster = await service.splitSeries(
      'user-1',
      'task-1',
      splitAt,
      {},
    );

    const oldRule = recurrenceDb.store.get('rule-1') as RecurrenceRule;
    const newRule = recurrenceDb.store.get(
      newMaster.recurrenceRuleId as string,
    ) as RecurrenceRule;

    // New count recomputed to 10 − 4 = 6.
    expect(newRule.count).toBe(6);

    const oldStarts = expandStarts(
      engine,
      oldRule,
      anchorStart,
      30 * 60_000,
      WIDE_FROM,
      WIDE_TO,
    );
    const newStarts = expandStarts(
      engine,
      newRule,
      newMaster.startAt as Date,
      30 * 60_000,
      WIDE_FROM,
      WIDE_TO,
    );

    expect(oldStarts).toHaveLength(4);
    expect(newStarts).toHaveLength(6);
    // Combined total equals the original COUNT exactly — and reconstructs it.
    expect(oldStarts.length + newStarts.length).toBe(10);
    expect([...oldStarts, ...newStarts]).toEqual(fullBefore);
  });

  it('lands a split exactly on an existing exception as the new series’ first instance', async () => {
    // The 2026-06-05 occurrence carries a rename override. Splitting exactly on
    // it must copy that exception forward onto the new task at the same
    // coordinate (its first instance), not leave it stranded on the old series.
    const rule = makeRule({
      id: 'rule-1',
      frequency: RecurrenceFrequency.DAILY,
    });
    const splitAt = zoned('2026-06-05T09:00');
    const anchor = makeTask({
      id: 'task-1',
      startAt: zoned('2026-06-01T09:00'),
      endAt: zoned('2026-06-01T09:30'),
      recurrenceRuleId: 'rule-1',
      recurrenceRule: rule,
    });
    const exceptionService = buildExceptionService();

    exceptionService.findForTask.mockResolvedValue([
      {
        id: 'boundary',
        taskId: 'task-1',
        originalStartAt: splitAt,
        isSkipped: false,
        overrideStartAt: null,
        overrideEndAt: null,
        overrideTitle: 'Boundary override',
        completedAt: null,
      },
    ] as TaskOccurrenceException[]);

    const recurrenceDb = buildFakeRecurrenceDb([rule]);
    const engine = new RecurrenceRuleService(recurrenceDb as never);
    const taskDb = {
      findOne: jest.fn().mockResolvedValue(anchor),
      findOneBy: jest.fn().mockResolvedValue(anchor),
      createInstance: jest.fn((partial: Partial<Task>) => ({ ...partial })),
      save: jest.fn((entity: Task) =>
        Promise.resolve({ ...entity, id: entity.id ?? 'new-task' }),
      ),
    };
    const service = new TaskService(
      taskDb as never,
      buildCalendarDatabaseService() as never,
      buildGroupDatabaseService() as never,
      engine as never,
      exceptionService as never,
    );

    const newMaster = await service.splitSeries(
      'user-1',
      'task-1',
      splitAt,
      {},
    );

    // The boundary exception is copied onto the new master at the split instant.
    expect(exceptionService.upsertOverride).toHaveBeenCalledWith(
      newMaster.id,
      splitAt,
      expect.objectContaining({ overrideTitle: 'Boundary override' }),
    );
  });

  it('rejects a cross-calendar group BEFORE any write (C3 — no partial split)', async () => {
    const rule = makeRule({
      id: 'rule-1',
      frequency: RecurrenceFrequency.DAILY,
    });
    const anchor = makeTask({
      id: 'task-1',
      calendarId: 'cal-1',
      startAt: zoned('2026-06-01T09:00'),
      endAt: zoned('2026-06-01T09:30'),
      recurrenceRuleId: 'rule-1',
      recurrenceRule: rule,
    });
    // The group resolves but lives in a DIFFERENT calendar.
    const groupDbOverride = {
      findOneBy: jest
        .fn()
        .mockResolvedValue({ id: 'grp-x', calendarId: 'other-cal' }),
    };
    const { service, recurrenceDb, savedTasks } = buildSeamService(anchor, {
      groupDbOverride,
    });

    await expect(
      service.splitSeries('user-1', 'task-1', zoned('2026-06-05T09:00'), {
        groupId: 'grp-x',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    // Nothing was written: the old rule is untouched (still NEVER), no new rule,
    // no new task. The guard ran before the first mutation.
    const oldRule = recurrenceDb.store.get('rule-1') as RecurrenceRule;

    expect(oldRule.endType).toBe(RecurrenceEndType.NEVER);
    expect(recurrenceDb.store.size).toBe(1);
    expect(savedTasks).toHaveLength(0);
  });

  it('applies a same-calendar group atomically on the new master (C3)', async () => {
    const rule = makeRule({
      id: 'rule-1',
      frequency: RecurrenceFrequency.DAILY,
    });
    const anchor = makeTask({
      id: 'task-1',
      calendarId: 'cal-1',
      startAt: zoned('2026-06-01T09:00'),
      endAt: zoned('2026-06-01T09:30'),
      recurrenceRuleId: 'rule-1',
      recurrenceRule: rule,
    });
    const groupDbOverride = {
      findOneBy: jest
        .fn()
        .mockResolvedValue({ id: 'grp-1', calendarId: 'cal-1' }),
    };
    const { service, taskDb } = buildSeamService(anchor, { groupDbOverride });

    await service.splitSeries('user-1', 'task-1', zoned('2026-06-05T09:00'), {
      groupId: 'grp-1',
    });

    // The group is set in the SAME createInstance — no follow-up update needed.
    expect(taskDb.createInstance).toHaveBeenCalledWith(
      expect.objectContaining({
        groupId: 'grp-1',
        recurrenceRuleId: 'rule-new-1',
      }),
    );
  });
});

describe('TaskService.endSeriesAt (T-3 delete this-and-following)', () => {
  /**
   * Wires a TaskService with the real engine (Map-backed CRUD) so `endSeriesAt`
   * truncates against the actual UNTIL-date conversion. `findOne` returns the
   * rule-bearing anchor (relation-aware load).
   */
  const buildService = (anchor: Task, rule?: RecurrenceRule) => {
    const recurrenceDb = buildFakeRecurrenceDb(rule ? [rule] : []);
    const engine = new RecurrenceRuleService(recurrenceDb as never);
    const taskDb = {
      findOne: jest.fn().mockResolvedValue(anchor),
      findOneBy: jest.fn().mockResolvedValue(anchor),
      createInstance: jest.fn((partial: Partial<Task>) => ({ ...partial })),
      save: jest.fn((entity: Task) => Promise.resolve(entity)),
    };
    const service = new TaskService(
      taskDb as never,
      buildCalendarDatabaseService() as never,
      buildGroupDatabaseService() as never,
      engine as never,
      buildExceptionService() as never,
    );

    return { service, engine, recurrenceDb, taskDb };
  };

  it('truncates the rule at the day before the occurrence, preserving past ones', async () => {
    const rule = makeRule({
      id: 'rule-1',
      frequency: RecurrenceFrequency.DAILY,
    });
    const anchorStart = zoned('2026-06-01T09:00');
    const anchor = makeTask({
      id: 'task-1',
      startAt: anchorStart,
      endAt: zoned('2026-06-01T09:30'),
      recurrenceRuleId: 'rule-1',
      recurrenceRule: rule,
    });
    const { service, engine, recurrenceDb, taskDb } = buildService(
      anchor,
      rule,
    );

    const cutAt = zoned('2026-06-05T09:00');

    await service.endSeriesAt('user-1', 'task-1', cutAt);

    // The rule was converted to UNTIL_DATE the day before — NOT a whole-series
    // soft-delete (the task row is never stamped deletedAt).
    const ended = recurrenceDb.store.get('rule-1') as RecurrenceRule;

    expect(ended.endType).toBe(RecurrenceEndType.UNTIL_DATE);
    expect(ended.endDate).toBe('2026-06-04');
    expect(taskDb.save).not.toHaveBeenCalled();

    const survivors = expandStarts(
      engine,
      ended,
      anchorStart,
      30 * 60_000,
      zoned('2026-01-01T00:00'),
      zoned('2027-01-01T00:00'),
    ).map((time) => localDate(new Date(time)));

    // The four occurrences before the cut survive; the cut one and later are gone.
    expect(survivors).toEqual([
      '2026-06-01',
      '2026-06-02',
      '2026-06-03',
      '2026-06-04',
    ]);
  });

  it('soft-deletes the whole task when the cut equals the series start', async () => {
    const rule = makeRule({
      id: 'rule-1',
      frequency: RecurrenceFrequency.DAILY,
    });
    const seriesStart = zoned('2026-06-01T09:00');
    const anchor = makeTask({
      id: 'task-1',
      startAt: seriesStart,
      endAt: zoned('2026-06-01T09:30'),
      recurrenceRuleId: 'rule-1',
      recurrenceRule: rule,
    });
    const { service, recurrenceDb, taskDb } = buildService(anchor, rule);

    await service.endSeriesAt('user-1', 'task-1', seriesStart);

    // No past to keep — the whole task is soft-deleted, the rule left untouched.
    expect(anchor.deletedAt).toBeInstanceOf(Date);
    expect(taskDb.save).toHaveBeenCalledTimes(1);
    expect((recurrenceDb.store.get('rule-1') as RecurrenceRule).endType).toBe(
      RecurrenceEndType.NEVER,
    );
  });

  it('soft-deletes a non-recurring task (no rule to truncate)', async () => {
    const anchor = makeTask({ id: 'task-1', recurrenceRuleId: null });
    const { service, taskDb } = buildService(anchor);

    await service.endSeriesAt('user-1', 'task-1', zoned('2026-06-05T09:00'));

    expect(anchor.deletedAt).toBeInstanceOf(Date);
    expect(taskDb.save).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Group-recurrence inheritance (A1)
// ---------------------------------------------------------------------------

describe('TaskService.findOccurrencesInRange — group-recurrence inheritance', () => {
  /**
   * Builds a service wired with the real expansion engine and a routed task-db
   * mock that can serve both `recurring` (own-rule) and `groupInherited` buckets.
   */
  const buildService = (
    fixtures: RangeFixtures,
    exceptionService = buildExceptionService(),
  ) => {
    const taskDb = { findAll: routedFindAll(fixtures) };
    const calendarDb = buildCalendarDatabaseService();
    const realEngine = new RecurrenceRuleService(null as never);
    const service = new TaskService(
      taskDb as never,
      calendarDb as never,
      buildGroupDatabaseService() as never,
      realEngine as never,
      exceptionService as never,
    );

    return { service, taskDb, exceptionService };
  };

  /**
   * Builds a TaskGroup with a default recurrence rule already attached.
   */
  const makeGroupWithRule = (
    groupId: string,
    rule: RecurrenceRule,
  ): TaskGroup =>
    ({
      id: groupId,
      calendarId: 'cal-1',
      name: 'Test Group',
      defaultRecurrenceRuleId: rule.id,
      defaultRecurrenceRule: rule,
    }) as unknown as TaskGroup;

  it('expands a task that has no own rule via its group default rule', async () => {
    const groupRule = makeRule({
      id: 'group-rule-1',
      frequency: RecurrenceFrequency.DAILY,
    });
    const group = makeGroupWithRule('group-1', groupRule);

    // A task with no own recurrenceRuleId but assigned to a group with a default
    // rule — it must expand using the group's rule.
    const inherited = makeTask({
      id: 't-inherited',
      groupId: 'group-1',
      group,
      startAt: zoned('2026-06-01T09:00'),
      endAt: zoned('2026-06-01T09:30'),
      recurrenceRuleId: null,
      recurrenceRule: null,
    });

    const { service } = buildService({ groupInherited: [inherited] });

    const result = await service.findOccurrencesInRange(
      'user-1',
      WINDOW_FROM,
      WINDOW_TO,
    );

    expect(result).toHaveLength(7);
    expect(result.every((occ) => occ.task.id === 't-inherited')).toBe(true);
    expect(result.every((occ) => occ.isRecurring)).toBe(true);
  });

  it('does not double-count a group-inherited recurring task surfaced by both reads', async () => {
    // Regression: a real Postgres returns the SAME row from the one-off query
    // (`recurrenceRuleId IS NULL`, no group filter) AND the group-inherited query.
    // The bucket-routed mock only exposes that overlap when the task is placed in
    // BOTH buckets — mirroring the DB. Before the fix this produced a phantom flat
    // one-off at the anchor PLUS the expanded series (8); it must be just 7.
    const groupRule = makeRule({
      id: 'group-rule-1',
      frequency: RecurrenceFrequency.DAILY,
    });
    const group = makeGroupWithRule('group-1', groupRule);
    const inherited = makeTask({
      id: 't-inherited',
      groupId: 'group-1',
      group,
      startAt: zoned('2026-06-01T09:00'),
      endAt: zoned('2026-06-01T09:30'),
      recurrenceRuleId: null,
      recurrenceRule: null,
    });

    const { service } = buildService({
      timedWithEnd: [inherited],
      groupInherited: [inherited],
    });

    const result = await service.findOccurrencesInRange(
      'user-1',
      WINDOW_FROM,
      WINDOW_TO,
    );

    // Expanded once via the group rule (7 daily) — never also as a flat one-off.
    expect(result).toHaveLength(7);
    expect(result.every((occ) => occ.isRecurring)).toBe(true);
    expect(result.filter((occ) => !occ.isRecurring)).toHaveLength(0);
    expect(result.every((occ) => occ.task.id === 't-inherited')).toBe(true);
  });

  it("a task's own rule overrides the group default", async () => {
    const groupRule = makeRule({
      id: 'group-rule-1',
      frequency: RecurrenceFrequency.DAILY,
    });
    const ownRule = makeRule({
      id: 'own-rule-1',
      frequency: RecurrenceFrequency.WEEKLY,
      byWeekday: [0], // Monday only (0 = Mon in entity encoding)
    });
    const group = makeGroupWithRule('group-1', groupRule);

    // A task WITH its own rule, also assigned to a group with a rule.
    // The own rule (weekly Mon) must win over the group's (daily).
    // Jun 1 2026 is a Monday — use it as the anchor.
    const ownRuleTask = makeTask({
      id: 't-own-rule',
      groupId: 'group-1',
      group,
      startAt: zoned('2026-06-01T09:00'), // Monday Jun 1
      endAt: zoned('2026-06-01T09:30'),
      recurrenceRuleId: 'own-rule-1',
      recurrenceRule: ownRule,
    });

    const { service } = buildService({ recurring: [ownRuleTask] });

    const result = await service.findOccurrencesInRange(
      'user-1',
      WINDOW_FROM,
      WINDOW_TO,
    );

    // Weekly-Mon gives 1 occurrence in the 7-day window (Jun 1 only).
    expect(result).toHaveLength(1);
    expect(result[0].task.id).toBe('t-own-rule');
    expect(localDate(result[0].occurrenceStart)).toBe('2026-06-01');
  });

  it('changing the group default changes expansion for tasks without own rules', async () => {
    const weeklyMonRule = makeRule({
      id: 'group-rule-1',
      frequency: RecurrenceFrequency.WEEKLY,
      byWeekday: [0], // Monday (0 = Mon in entity encoding)
    });
    const group = makeGroupWithRule('group-1', weeklyMonRule);

    // Jun 1 2026 is a Monday — use it as the anchor.
    const inherited = makeTask({
      id: 't-inherited',
      groupId: 'group-1',
      group,
      startAt: zoned('2026-06-01T09:00'), // Monday Jun 1
      endAt: zoned('2026-06-01T09:30'),
      recurrenceRuleId: null,
      recurrenceRule: null,
    });

    const { service: weeklyService } = buildService({
      groupInherited: [inherited],
    });
    const weeklyResult = await weeklyService.findOccurrencesInRange(
      'user-1',
      WINDOW_FROM,
      WINDOW_TO,
    );

    // Weekly on Monday gives 1 occurrence in the window.
    expect(weeklyResult).toHaveLength(1);

    // Now swap the group default to DAILY and confirm expansion changes.
    const dailyRule = makeRule({
      id: 'group-rule-2',
      frequency: RecurrenceFrequency.DAILY,
    });
    const groupWithDailyRule = makeGroupWithRule('group-1', dailyRule);
    const inheritedWithDaily = makeTask({
      id: 't-inherited',
      groupId: 'group-1',
      group: groupWithDailyRule,
      startAt: zoned('2026-06-01T09:00'),
      endAt: zoned('2026-06-01T09:30'),
      recurrenceRuleId: null,
      recurrenceRule: null,
    });

    const { service: dailyService } = buildService({
      groupInherited: [inheritedWithDaily],
    });
    const dailyResult = await dailyService.findOccurrencesInRange(
      'user-1',
      WINDOW_FROM,
      WINDOW_TO,
    );

    // Daily gives 7 occurrences.
    expect(dailyResult).toHaveLength(7);
  });

  it('ignores group-assigned tasks whose group has no default rule', async () => {
    // A group with NO default rule.
    const groupNoRule = {
      id: 'group-1',
      calendarId: 'cal-1',
      defaultRecurrenceRuleId: null,
      defaultRecurrenceRule: null,
    } as unknown as TaskGroup;

    const task = makeTask({
      id: 't-orphan',
      groupId: 'group-1',
      group: groupNoRule,
      startAt: zoned('2026-06-01T09:00'),
      recurrenceRuleId: null,
      recurrenceRule: null,
    });

    const { service } = buildService({ groupInherited: [task] });

    const result = await service.findOccurrencesInRange(
      'user-1',
      WINDOW_FROM,
      WINDOW_TO,
    );

    // No expansion without a rule — the task does not appear.
    expect(result).toHaveLength(0);
  });
});
