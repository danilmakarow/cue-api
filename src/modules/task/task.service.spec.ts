import { BadRequestException } from '@nestjs/common';
import { DateTime } from 'luxon';
import { FindManyOptions, FindOptionsWhere } from 'typeorm';

// `@Transactional()` (used by `create` / `update`) requires a registered
// transactional data source at runtime, which a pure unit spec has no DB to
// provide. Stub the decorator to a pass-through so the methods' logic can be
// exercised directly; the real transaction wrapping is covered at integration.
jest.mock('typeorm-transactional', () => ({
  Transactional: () => () => undefined,
}));

import { TaskService } from './task.service';
import {
  Calendar,
  RecurrenceEndType,
  RecurrenceFrequency,
  Task,
  TaskColor,
  TaskGroup,
  TaskOccurrenceException,
} from '@/modules/database/entities';
import { RecurrenceRuleService } from '@/modules/recurrence-rule/recurrence-rule.service';
import {
  RecurrenceConfig,
  RecurrenceSource,
} from '@/modules/recurrence-rule/recurrence.types';

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
    color: null,
    completedAt: null,
    notificationStrategyId: null,
    recurrenceConfig: null,
    deletedAt: null,
    ...overrides,
  }) as Task;

/**
 * Builds an inline RecurrenceConfig (DAILY / NEVER defaults). Named `makeRule`
 * for continuity, but it produces the inline config POJO the engine now reads.
 */
const makeRule = (
  overrides: Partial<RecurrenceConfig> = {},
): RecurrenceConfig => ({
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
  ...overrides,
});

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
 * - `recurrenceConfig: Not(IsNull())` → `recurring` (own-config anchors)
 * - `recurrenceConfig: IsNull()` + `groupId: Not(IsNull())` → `groupInherited`
 * - `startAt: IsNull()` → `todos`
 * - `endAt: IsNull()` → `timedNoEnd`
 * - otherwise → `timedWithEnd`
 */
const routedFindAll = (fixtures: RangeFixtures) =>
  jest.fn((options?: FindManyOptions<Task>) => {
    const where = (options?.where ?? {}) as FindOptionsWhere<Task>;
    const recurrenceTag = operatorType(where.recurrenceConfig);
    const groupIdTag = operatorType(where.groupId);
    const excluded = excludedId(where);
    const dropsCompleted = operatorType(where.completedAt) === 'isNull';

    const bucket = (() => {
      if (recurrenceTag === 'not') return fixtures.recurring ?? [];
      // group-inherited: recurrenceConfig IS NULL + groupId IS NOT NULL
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
 * `findOneBy` stub that returns the loaded task for an id lookup but null for the
 * override-child lookup (a `parentTaskId` in the where) — i.e. no materialized
 * override child exists by default. Keeps the pre-override behavior of the
 * completion / skip / override paths intact under the new child-aware code.
 */
const routedFindOneBy = (task: Task | null) =>
  jest.fn((where: FindOptionsWhere<Task>) =>
    Promise.resolve('parentTaskId' in where ? null : task),
  );

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
  findOverride: jest
    .fn()
    .mockResolvedValue(null as TaskOccurrenceException | null),
  upsertOverride: jest.fn().mockResolvedValue({} as TaskOccurrenceException),
});

/**
 * Builds a notification-rule service stub (no per-task reminders by default).
 */
const buildNotificationRuleService = () => ({
  listByTask: jest.fn().mockResolvedValue([]),
  createForTask: jest.fn().mockResolvedValue([]),
  replaceForTask: jest.fn().mockResolvedValue([]),
});

/**
 * Builds a sync-state service stub — every mutation bumps the per-user revision;
 * the tests only need the call to resolve.
 */
const buildSyncStateService = () => ({
  bump: jest.fn().mockResolvedValue(undefined),
  getState: jest.fn().mockResolvedValue({
    revision: '1',
    changedAt: null,
    serverTime: new Date().toISOString(),
  }),
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
    const realEngine = new RecurrenceRuleService();
    const service = new TaskService(
      taskDb as never,
      calendarDb as never,
      buildGroupDatabaseService() as never,
      realEngine as never,
      exceptionService as never,
      buildNotificationRuleService() as never,
      buildSyncStateService() as never,
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
      recurrenceConfig: makeRule({ frequency: RecurrenceFrequency.DAILY }),
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
      recurrenceConfig: makeRule({ frequency: RecurrenceFrequency.DAILY }),
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
      recurrenceConfig: makeRule({ frequency: RecurrenceFrequency.DAILY }),
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

describe('TaskService recurring-series conflict checks (Story 9)', () => {
  /**
   * A `findAll` that honors the half-open timed-window intersection for the
   * `timedWithEnd` fixtures, so each per-occurrence `findOverlapping` probe only
   * clashes on the occurrence whose window actually overlaps the fixture — the
   * precise behaviour the real query has. Other buckets stay empty.
   */
  const windowAwareFindAll = (timedWithEnd: Task[]) =>
    jest.fn((options?: FindManyOptions<Task>) => {
      const where = (options?.where ?? {}) as FindOptionsWhere<Task>;

      // Only the timed-with-end clash query (startAt < endBound AND endAt >
      // startBound, recurrenceConfig IS NULL) reads the fixtures.
      if (
        operatorType(where.recurrenceConfig) !== 'isNull' ||
        operatorType(where.startAt) !== 'lessThan' ||
        operatorType(where.endAt) !== 'moreThan'
      ) {
        return Promise.resolve([]);
      }

      const endBound = (where.startAt as unknown as FindOperatorLike)
        .value as Date;
      const startBound = (where.endAt as unknown as FindOperatorLike)
        .value as Date;
      const excluded = excludedId(where);

      const rows = timedWithEnd.filter(
        (task) =>
          task.id !== excluded &&
          (task.startAt as Date).getTime() < endBound.getTime() &&
          (task.endAt as Date).getTime() > startBound.getTime(),
      );

      return Promise.resolve(rows);
    });

  const buildService = (timedWithEnd: Task[], anchorTask?: Task) => {
    const taskDb = {
      findAll: windowAwareFindAll(timedWithEnd),
      findOne: jest.fn().mockResolvedValue(anchorTask ?? null),
    };
    const calendarDb = buildCalendarDatabaseService();
    const realEngine = new RecurrenceRuleService();
    const service = new TaskService(
      taskDb as never,
      calendarDb as never,
      buildGroupDatabaseService() as never,
      realEngine as never,
      buildExceptionService() as never,
      buildNotificationRuleService() as never,
      buildSyncStateService() as never,
    );

    return { service, taskDb };
  };

  describe('findRecurringSeriesConflicts', () => {
    it('reports no conflicts when no occurrence overlaps', async () => {
      const { service } = buildService([]);

      const result = await service.findRecurringSeriesConflicts(
        'user-1',
        'cal-1',
        {
          title: 'Standup',
          startAt: zoned('2026-06-01T09:00'),
          endAt: zoned('2026-06-01T09:30'),
          timezone: 'America/New_York',
          recurrence: {
            frequency: RecurrenceFrequency.WEEKLY,
            endType: RecurrenceEndType.COUNT,
            count: 4,
          },
        },
      );

      expect(result.conflictDates).toHaveLength(0);
      expect(result.conflictingTasks).toHaveLength(0);
    });

    it('flags the clashing occurrence date(s) when one occurrence overlaps', async () => {
      // An existing event on the SECOND weekly occurrence (2026-06-08 09:00).
      const existing = makeTask({
        id: 't-existing',
        title: 'Gym',
        startAt: zoned('2026-06-08T09:00'),
        endAt: zoned('2026-06-08T09:30'),
      });
      const { service } = buildService([existing]);

      const result = await service.findRecurringSeriesConflicts(
        'user-1',
        'cal-1',
        {
          title: 'Standup',
          startAt: zoned('2026-06-01T09:00'),
          endAt: zoned('2026-06-01T09:30'),
          timezone: 'America/New_York',
          recurrence: {
            frequency: RecurrenceFrequency.WEEKLY,
            endType: RecurrenceEndType.COUNT,
            count: 4,
          },
        },
      );

      // Exactly the one clashing date, and the existing task it clashes with.
      expect(result.conflictDates.map((date) => localDate(date))).toEqual([
        '2026-06-08',
      ]);
      expect(result.conflictingTasks.map((task) => task.id)).toEqual([
        't-existing',
      ]);
    });

    it('terminates without hanging on a NEVER-ending (infinite) rule', async () => {
      const { service } = buildService([]);

      const result = await service.findRecurringSeriesConflicts(
        'user-1',
        'cal-1',
        {
          title: 'Standup',
          startAt: zoned('2026-06-01T09:00'),
          endAt: zoned('2026-06-01T09:30'),
          timezone: 'America/New_York',
          // NEVER-ending: bounded only by the look-ahead horizon, never runs away.
          recurrence: { frequency: RecurrenceFrequency.DAILY },
        },
      );

      expect(result.conflictDates).toHaveLength(0);
    });
  });

  describe('findRecurringEditConflicts', () => {
    it('returns no conflicts when neither time nor rule changed', async () => {
      const anchor = makeTask({
        id: 't-1',
        startAt: zoned('2026-06-01T09:00'),
        endAt: zoned('2026-06-01T09:30'),
        recurrenceConfig: makeRule({ frequency: RecurrenceFrequency.WEEKLY }),
      });
      const { service } = buildService([], anchor);

      const result = await service.findRecurringEditConflicts('user-1', 't-1', {
        title: 'Renamed only',
      });

      expect(result.conflictDates).toHaveLength(0);
    });

    it('flags an overlap a TIME change introduces, excluding the edited series', async () => {
      // The edited series' own occupancy (id t-1) must NOT count as a clash, but a
      // different existing event on the moved occurrence must.
      const anchor = makeTask({
        id: 't-1',
        startAt: zoned('2026-06-01T09:00'),
        endAt: zoned('2026-06-01T09:30'),
        recurrenceConfig: makeRule({
          frequency: RecurrenceFrequency.WEEKLY,
          endType: RecurrenceEndType.COUNT,
          count: 2,
        }),
      });
      const other = makeTask({
        id: 't-other',
        title: 'Lunch',
        startAt: zoned('2026-06-01T11:00'),
        endAt: zoned('2026-06-01T11:30'),
      });
      const { service } = buildService([other], anchor);

      // Move the series to 11:00 (overlapping Lunch on the first occurrence).
      const result = await service.findRecurringEditConflicts('user-1', 't-1', {
        startAt: zoned('2026-06-01T11:00').toISOString(),
        endAt: zoned('2026-06-01T11:30').toISOString(),
      });

      expect(result.conflictingTasks.map((task) => task.id)).toContain(
        't-other',
      );
      expect(result.conflictingTasks.map((task) => task.id)).not.toContain(
        't-1',
      );
    });
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
    // Recurrence is inline now (ADR 0054) — the service maps the DTO to a config
    // via the static `RecurrenceRuleService.toConfig`, so the real (pure) engine
    // is wired and there is no rule-CRUD collaborator to mock.
    const engine = new RecurrenceRuleService();
    const exceptionService = buildExceptionService();
    const service = new TaskService(
      taskDb as never,
      calendarDb as never,
      groupDb as never,
      engine as never,
      exceptionService as never,
      buildNotificationRuleService() as never,
      buildSyncStateService() as never,
    );

    return { service, taskDb, calendarDb, groupDb };
  };

  it('stores ONE inline config on ONE task for a recurring task (never N rows)', async () => {
    const { service, taskDb } = buildService();

    const result = await service.create('user-1', {
      calendarId: 'cal-1',
      title: 'Standup',
      timezone: 'America/New_York',
      startAt: '2026-06-01T13:00:00.000Z',
      recurrence: { frequency: RecurrenceFrequency.DAILY },
    });

    expect(taskDb.save).toHaveBeenCalledTimes(1);
    expect(taskDb.createInstance).toHaveBeenCalledWith(
      expect.objectContaining({ recurrenceConfig: makeRule() }),
    );
    expect(result.recurrenceConfig).toEqual(makeRule());
  });

  it('rejects a recurring task without an anchor startAt', async () => {
    const { service, taskDb } = buildService();

    await expect(
      service.create('user-1', {
        calendarId: 'cal-1',
        title: 'No anchor',
        timezone: 'America/New_York',
        recurrence: { frequency: RecurrenceFrequency.DAILY },
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(taskDb.save).not.toHaveBeenCalled();
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
        recurrenceConfig: null,
        // requiresCompletion defaults to null on the row now — the effective
        // `false`/group-inherited value is resolved by the resolver (ADR 0054).
        requiresCompletion: null,
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
      findOneBy: routedFindOneBy(task),
      findAllBy: jest.fn().mockResolvedValue([]),
      // `findByIdWithRule` / the membership guard read the anchor via `findOne`;
      // recurrence is the inline config on the row, so the fixture carries it.
      findOne: jest.fn().mockResolvedValue(task),
      createInstance: jest.fn((partial: Partial<Task>) => ({ ...partial })),
      save: jest.fn((entity: Task) =>
        Promise.resolve({ ...entity, id: entity.id ?? 'new-task' }),
      ),
    };
    const calendarDb = buildCalendarDatabaseService();
    // Inline recurrence (ADR 0054): the real (pure) engine, no rule-CRUD mock.
    const engine = new RecurrenceRuleService();
    const exceptionService = buildExceptionService();
    const service = new TaskService(
      taskDb as never,
      calendarDb as never,
      buildGroupDatabaseService() as never,
      engine as never,
      exceptionService as never,
      buildNotificationRuleService() as never,
      buildSyncStateService() as never,
    );

    return { service, taskDb, exceptionService };
  };

  describe('applyOccurrenceOverride', () => {
    it('upserts a skip exception for a recurring task (delete-one)', async () => {
      const task = makeTask({ recurrenceConfig: makeRule() });
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
      const task = makeTask({ recurrenceConfig: null });
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
        findOneBy: routedFindOneBy(anchor),
      findAllBy: jest.fn().mockResolvedValue([]),
        findOne: jest.fn().mockResolvedValue(anchor),
        createInstance: jest.fn((partial: Partial<Task>) => ({ ...partial })),
        save: jest.fn((entity: Task) => Promise.resolve({ ...entity })),
      };
      const service = new TaskService(
        taskDb as never,
        buildCalendarDatabaseService() as never,
        buildGroupDatabaseService() as never,
        new RecurrenceRuleService() as never,
        exceptionService as never,
        buildNotificationRuleService() as never,
      buildSyncStateService() as never,
      );

      return { service, exceptionService };
    };

    const dailyAnchor = () =>
      makeTask({
        recurrenceConfig: makeRule({ frequency: RecurrenceFrequency.DAILY }),
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

  describe('findOccurrenceException', () => {
    it('validates ownership then returns the delegated override row', async () => {
      const task = makeTask({ recurrenceConfig: makeRule() });
      const { service, taskDb, exceptionService } = buildService(task);
      const originalStart = zoned('2026-06-02T09:00');
      const row = { id: 'exc-1' } as TaskOccurrenceException;

      exceptionService.findOverride.mockResolvedValue(row);

      const result = await service.findOccurrenceException(
        'user-1',
        'task-1',
        originalStart,
      );

      // Ownership is asserted via findById (the anchor load) before reading.
      expect(taskDb.findOneBy).toHaveBeenCalledWith({ id: 'task-1' });
      expect(exceptionService.findOverride).toHaveBeenCalledWith(
        'task-1',
        originalStart,
      );
      expect(result).toBe(row);
    });

    it('returns null when the occurrence has no override', async () => {
      const task = makeTask({ recurrenceConfig: makeRule() });
      const { service, exceptionService } = buildService(task);

      exceptionService.findOverride.mockResolvedValue(null);

      const result = await service.findOccurrenceException(
        'user-1',
        'task-1',
        zoned('2026-06-02T09:00'),
      );

      expect(result).toBeNull();
    });
  });

  describe('setOccurrenceCompleted', () => {
    it('writes a per-instance completedAt for a recurring task', async () => {
      const task = makeTask({ recurrenceConfig: makeRule() });
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
      const task = makeTask({ recurrenceConfig: makeRule() });
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
      const task = makeTask({ recurrenceConfig: null, completedAt: null });
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
      const task = makeTask({ recurrenceConfig: makeRule() });
      const persistedAt = zoned('2026-06-02T10:05');
      const exceptionService = buildExceptionService();

      exceptionService.upsertOverride.mockResolvedValue({
        completedAt: persistedAt,
      } as TaskOccurrenceException);

      const taskDb = {
        findOneBy: routedFindOneBy(task),
      findAllBy: jest.fn().mockResolvedValue([]),
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
        buildNotificationRuleService() as never,
      buildSyncStateService() as never,
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
      const task = makeTask({ recurrenceConfig: null, completedAt: null });
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
        recurrenceConfig: makeRule(),
        startAt: seriesStart,
        endAt: zoned('2026-06-01T09:30'),
      });
      const { service, taskDb } = buildService(task);

      await service.splitSeries('user-1', 'task-1', seriesStart, {
        title: 'Renamed all',
      });

      // No new anchor — this IS "all" (a plain master update).
      expect(taskDb.createInstance).not.toHaveBeenCalled();
      expect(task.title).toBe('Renamed all');
      expect(taskDb.save).toHaveBeenCalledTimes(1);
    });

    it('ends the old inline config, creates a new anchor with its own config, and copies forward exceptions', async () => {
      const task = makeTask({
        recurrenceConfig: makeRule({ frequency: RecurrenceFrequency.DAILY }),
        startAt: zoned('2026-06-01T09:00'),
        endAt: zoned('2026-06-01T09:30'),
      });
      const { service, taskDb, exceptionService } = buildService(task);

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

      // The OLD anchor's inline config was ended the day before the split,
      // in-place (mutate-and-save), not via a rule-CRUD call.
      expect(task.recurrenceConfig).toEqual(
        expect.objectContaining({
          endType: RecurrenceEndType.UNTIL_DATE,
          endDate: '2026-06-04',
        }),
      );
      // A new anchor task with its OWN inline config was created.
      expect(taskDb.createInstance).toHaveBeenCalledWith(
        expect.objectContaining({
          recurrenceConfig: expect.objectContaining({
            frequency: RecurrenceFrequency.DAILY,
          }),
          title: 'New chapter',
          startAt: splitAt,
        }),
      );
      expect(newTask.recurrenceConfig).toEqual(
        expect.objectContaining({ frequency: RecurrenceFrequency.DAILY }),
      );

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
        recurrenceConfig: makeRule({ frequency: RecurrenceFrequency.DAILY }),
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
      const task = makeTask({ recurrenceConfig: null });
      const { service, taskDb } = buildService(task);

      await service.splitSeries('user-1', 'task-1', zoned('2026-06-05T09:00'), {
        title: 'Renamed',
      });

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
      findOneBy: routedFindOneBy(task),
      findAllBy: jest.fn().mockResolvedValue([]),
      save: jest.fn((entity: Task) => Promise.resolve(entity)),
    };
    const service = new TaskService(
      taskDb as never,
      buildCalendarDatabaseService() as never,
      buildGroupDatabaseService() as never,
      new RecurrenceRuleService() as never,
      buildExceptionService() as never,
      buildNotificationRuleService() as never,
      buildSyncStateService() as never,
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

describe('TaskService.update — per field', () => {
  /**
   * Builds a TaskService over a single mutable task fixture for the per-field
   * update tests. `groupDbOverride` lets the group-setting tests resolve a real
   * same-calendar group (the default stub resolves to `null`, which the un-group
   * and field-only tests never reach).
   */
  const buildService = (
    task: Task,
    groupDbOverride?: { findOneBy: jest.Mock },
  ) => {
    const taskDb = {
      findOneBy: routedFindOneBy(task),
      findAllBy: jest.fn().mockResolvedValue([]),
      save: jest.fn((entity: Task) => Promise.resolve(entity)),
    };
    const service = new TaskService(
      taskDb as never,
      buildCalendarDatabaseService() as never,
      (groupDbOverride ?? buildGroupDatabaseService()) as never,
      new RecurrenceRuleService() as never,
      buildExceptionService() as never,
      buildNotificationRuleService() as never,
      buildSyncStateService() as never,
    );

    return { service, taskDb };
  };

  /**
   * A group-database stub whose single group `group-1` lives in `cal-1` (the
   * default task's calendar), so `ensureGroupInCalendar` accepts it.
   */
  const sameCalendarGroupDb = () => ({
    findOneBy: jest
      .fn()
      .mockResolvedValue({ id: 'group-1', calendarId: 'cal-1' }),
  });

  it('persists a title change', async () => {
    const task = makeTask({ id: 'task-1', title: 'Old' });
    const { service, taskDb } = buildService(task);

    const result = await service.update('user-1', 'task-1', { title: 'New' });

    expect(result.title).toBe('New');
    expect(task.title).toBe('New');
    expect(taskDb.save).toHaveBeenCalledTimes(1);
  });

  it('persists setting notes', async () => {
    const task = makeTask({ id: 'task-1', notes: null });
    const { service, taskDb } = buildService(task);

    const result = await service.update('user-1', 'task-1', {
      notes: 'Bring the prototype',
    });

    expect(result.notes).toBe('Bring the prototype');
    expect(task.notes).toBe('Bring the prototype');
    expect(taskDb.save).toHaveBeenCalledTimes(1);
  });

  it('persists clearing notes to null', async () => {
    const task = makeTask({ id: 'task-1', notes: 'Existing note' });
    const { service, taskDb } = buildService(task);

    const result = await service.update('user-1', 'task-1', { notes: null });

    expect(result.notes).toBeNull();
    expect(task.notes).toBeNull();
    expect(taskDb.save).toHaveBeenCalledTimes(1);
  });

  it('persists setting startAt', async () => {
    const task = makeTask({ id: 'task-1', startAt: null });
    const { service, taskDb } = buildService(task);
    const nextStart = zoned('2026-06-03T09:00');

    const result = await service.update('user-1', 'task-1', {
      startAt: nextStart.toISOString(),
    });

    expect(result.startAt).toEqual(nextStart);
    expect(task.startAt).toEqual(nextStart);
    expect(taskDb.save).toHaveBeenCalledTimes(1);
  });

  it('persists clearing startAt to null (reverts a timed task to a todo)', async () => {
    const task = makeTask({
      id: 'task-1',
      startAt: zoned('2026-06-03T09:00'),
      endAt: null,
    });
    const { service, taskDb } = buildService(task);

    const result = await service.update('user-1', 'task-1', { startAt: null });

    // No anchor time → a timeless todo.
    expect(result.startAt).toBeNull();
    expect(task.startAt).toBeNull();
    expect(taskDb.save).toHaveBeenCalledTimes(1);
  });

  it('persists setting endAt', async () => {
    const task = makeTask({
      id: 'task-1',
      startAt: zoned('2026-06-03T09:00'),
      endAt: null,
    });
    const { service, taskDb } = buildService(task);
    const nextEnd = zoned('2026-06-03T10:00');

    const result = await service.update('user-1', 'task-1', {
      endAt: nextEnd.toISOString(),
    });

    expect(result.endAt).toEqual(nextEnd);
    expect(task.endAt).toEqual(nextEnd);
    expect(taskDb.save).toHaveBeenCalledTimes(1);
  });

  it('persists clearing endAt to null', async () => {
    const task = makeTask({
      id: 'task-1',
      startAt: zoned('2026-06-03T09:00'),
      endAt: zoned('2026-06-03T10:00'),
    });
    const { service, taskDb } = buildService(task);

    const result = await service.update('user-1', 'task-1', { endAt: null });

    expect(result.endAt).toBeNull();
    expect(task.endAt).toBeNull();
    expect(taskDb.save).toHaveBeenCalledTimes(1);
  });

  it('persists an isAllDay change', async () => {
    const task = makeTask({ id: 'task-1', isAllDay: false });
    const { service, taskDb } = buildService(task);

    const result = await service.update('user-1', 'task-1', { isAllDay: true });

    expect(result.isAllDay).toBe(true);
    expect(task.isAllDay).toBe(true);
    expect(taskDb.save).toHaveBeenCalledTimes(1);
  });

  it('persists a timezone change', async () => {
    const task = makeTask({ id: 'task-1', timezone: 'America/New_York' });
    const { service, taskDb } = buildService(task);

    const result = await service.update('user-1', 'task-1', {
      timezone: 'Europe/Berlin',
    });

    expect(result.timezone).toBe('Europe/Berlin');
    expect(task.timezone).toBe('Europe/Berlin');
    expect(taskDb.save).toHaveBeenCalledTimes(1);
  });

  it('persists requiresCompletion set to false', async () => {
    const task = makeTask({ id: 'task-1', requiresCompletion: true });
    const { service, taskDb } = buildService(task);

    const result = await service.update('user-1', 'task-1', {
      requiresCompletion: false,
    });

    expect(result.requiresCompletion).toBe(false);
    expect(task.requiresCompletion).toBe(false);
    expect(taskDb.save).toHaveBeenCalledTimes(1);
  });

  it('persists requiresCompletion set to true', async () => {
    const task = makeTask({ id: 'task-1', requiresCompletion: false });
    const { service, taskDb } = buildService(task);

    const result = await service.update('user-1', 'task-1', {
      requiresCompletion: true,
    });

    expect(result.requiresCompletion).toBe(true);
    expect(task.requiresCompletion).toBe(true);
    expect(taskDb.save).toHaveBeenCalledTimes(1);
  });

  it('persists clearing requiresCompletion to null (inherits the effective default)', async () => {
    const task = makeTask({ id: 'task-1', requiresCompletion: true });
    const { service, taskDb } = buildService(task);

    const result = await service.update('user-1', 'task-1', {
      requiresCompletion: null,
    });

    // Cleared to null on the row — the effective value now resolves via the
    // group default (then `false`) through the effective-settings resolver.
    expect(result.requiresCompletion).toBeNull();
    expect(task.requiresCompletion).toBeNull();
    expect(taskDb.save).toHaveBeenCalledTimes(1);
  });

  it('persists a preset color', async () => {
    const task = makeTask({ id: 'task-1', color: null });
    const { service, taskDb } = buildService(task);

    const result = await service.update('user-1', 'task-1', {
      color: TaskColor.BLUE,
    });

    expect(result.color).toBe(TaskColor.BLUE);
    expect(task.color).toBe(TaskColor.BLUE);
    expect(taskDb.save).toHaveBeenCalledTimes(1);
  });

  it('persists a custom #hex color', async () => {
    const task = makeTask({ id: 'task-1', color: TaskColor.BLUE });
    const { service, taskDb } = buildService(task);

    const result = await service.update('user-1', 'task-1', {
      color: '#a1b2c3',
    });

    expect(result.color).toBe('#a1b2c3');
    expect(task.color).toBe('#a1b2c3');
    expect(taskDb.save).toHaveBeenCalledTimes(1);
  });

  it('persists clearing color to null', async () => {
    const task = makeTask({ id: 'task-1', color: TaskColor.GREEN });
    const { service, taskDb } = buildService(task);

    const result = await service.update('user-1', 'task-1', { color: null });

    expect(result.color).toBeNull();
    expect(task.color).toBeNull();
    expect(taskDb.save).toHaveBeenCalledTimes(1);
  });

  it('persists setting groupId (validated against the same calendar)', async () => {
    const task = makeTask({ id: 'task-1', groupId: null });
    const groupDb = sameCalendarGroupDb();
    const { service, taskDb } = buildService(task, groupDb);

    const result = await service.update('user-1', 'task-1', {
      groupId: 'group-1',
    });

    expect(result.groupId).toBe('group-1');
    expect(task.groupId).toBe('group-1');
    // The group's co-location was checked before the write.
    expect(groupDb.findOneBy).toHaveBeenCalledWith({ id: 'group-1' });
    expect(taskDb.save).toHaveBeenCalledTimes(1);
  });

  it('persists clearing groupId to null (un-groups the task, no group lookup)', async () => {
    const task = makeTask({ id: 'task-1', groupId: 'group-1' });
    const groupDb = sameCalendarGroupDb();
    const { service, taskDb } = buildService(task, groupDb);

    const result = await service.update('user-1', 'task-1', { groupId: null });

    expect(result.groupId).toBeNull();
    expect(task.groupId).toBeNull();
    // Un-grouping never validates a group — the co-location check is skipped.
    expect(groupDb.findOneBy).not.toHaveBeenCalled();
    expect(taskDb.save).toHaveBeenCalledTimes(1);
  });

  it('short-circuits without saving when no field actually changes', async () => {
    const task = makeTask({
      id: 'task-1',
      title: 'Same',
      notes: 'Same note',
      isAllDay: true,
      requiresCompletion: false,
    });
    const { service, taskDb } = buildService(task);

    // Every provided value equals the current one — a true no-op.
    const result = await service.update('user-1', 'task-1', {
      title: 'Same',
      notes: 'Same note',
      isAllDay: true,
      requiresCompletion: false,
    });

    // The same row is returned as-is, without a needless save.
    expect(result).toBe(task);
    expect(taskDb.save).not.toHaveBeenCalled();
  });
});

describe('TaskService.update — recurrence regression', () => {
  /**
   * Builds a TaskService over a single mutable task fixture for the recurrence
   * set/change/clear regression tests. The real (pure) engine is wired; the
   * service maps the recurrence DTO to a config via the static
   * `RecurrenceRuleService.toConfig`.
   */
  const buildService = (task: Task) => {
    const taskDb = {
      findOneBy: routedFindOneBy(task),
      findAllBy: jest.fn().mockResolvedValue([]),
      save: jest.fn((entity: Task) => Promise.resolve(entity)),
    };
    const service = new TaskService(
      taskDb as never,
      buildCalendarDatabaseService() as never,
      buildGroupDatabaseService() as never,
      new RecurrenceRuleService() as never,
      buildExceptionService() as never,
      buildNotificationRuleService() as never,
      buildSyncStateService() as never,
    );

    return { service, taskDb };
  };

  it('SET: a task with no rule gains an inline recurrenceConfig', async () => {
    const task = makeTask({
      id: 'task-1',
      startAt: zoned('2026-06-01T09:00'),
      endAt: zoned('2026-06-01T09:30'),
      recurrenceConfig: null,
    });
    const { service, taskDb } = buildService(task);

    const result = await service.update('user-1', 'task-1', {
      recurrence: { frequency: RecurrenceFrequency.DAILY },
    });

    expect(result.recurrenceConfig).toEqual(makeRule());
    expect(task.recurrenceConfig).toEqual(makeRule());
    // A recurrence-only change still persists, even with no other field touched.
    expect(taskDb.save).toHaveBeenCalledTimes(1);
  });

  it('CHANGE: an existing rule is replaced (interval 1 → 2)', async () => {
    const task = makeTask({
      id: 'task-1',
      startAt: zoned('2026-06-01T09:00'),
      endAt: zoned('2026-06-01T09:30'),
      recurrenceConfig: makeRule({
        frequency: RecurrenceFrequency.DAILY,
        interval: 1,
      }),
    });
    const { service, taskDb } = buildService(task);

    const result = await service.update('user-1', 'task-1', {
      recurrence: { frequency: RecurrenceFrequency.DAILY, interval: 2 },
    });

    expect(result.recurrenceConfig?.interval).toBe(2);
    expect(task.recurrenceConfig?.interval).toBe(2);
    expect(taskDb.save).toHaveBeenCalledTimes(1);
  });

  it('CLEAR: setting recurrence to null stops the task repeating', async () => {
    const task = makeTask({
      id: 'task-1',
      startAt: zoned('2026-06-01T09:00'),
      endAt: zoned('2026-06-01T09:30'),
      recurrenceConfig: makeRule({ frequency: RecurrenceFrequency.DAILY }),
    });
    const { service, taskDb } = buildService(task);

    const result = await service.update('user-1', 'task-1', {
      recurrence: null,
    });

    expect(result.recurrenceConfig).toBeNull();
    expect(task.recurrenceConfig).toBeNull();
    expect(taskDb.save).toHaveBeenCalledTimes(1);
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
    const realEngine = new RecurrenceRuleService();
    const service = new TaskService(
      taskDb as never,
      calendarDb as never,
      buildGroupDatabaseService() as never,
      realEngine as never,
      exceptionService as never,
      buildNotificationRuleService() as never,
      buildSyncStateService() as never,
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
      recurrenceConfig: makeRule({ frequency: RecurrenceFrequency.DAILY }),
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
      recurrenceConfig: makeRule({ frequency: RecurrenceFrequency.WEEKLY }),
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
      recurrenceConfig: makeRule({ frequency: RecurrenceFrequency.DAILY }),
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
      new RecurrenceRuleService() as never,
      buildExceptionService() as never,
      buildNotificationRuleService() as never,
      buildSyncStateService() as never,
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
      recurrenceConfig: makeRule({ frequency: RecurrenceFrequency.DAILY }),
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
/**
 * Expands an inline config via the real engine using a throwaway anchor carrying
 * the given start/duration, returning the generated `originalStart` epoch-millis
 * in order.
 */
const expandStarts = (
  engine: RecurrenceRuleService,
  config: RecurrenceConfig,
  startAt: Date,
  durationMs: number,
  from: Date,
  to: Date,
): number[] => {
  const anchor = makeTask({
    startAt,
    endAt: new Date(startAt.getTime() + durationMs),
    recurrenceConfig: config,
  });

  return engine
    .expandOccurrences(anchor, config, [], from, to)
    .map((occurrence) => (occurrence.originalStart as Date).getTime());
};

describe('TaskService.splitSeries (real-engine seam)', () => {
  const WIDE_FROM = zoned('2026-01-01T00:00');
  const WIDE_TO = zoned('2027-01-01T00:00');

  /**
   * Wires a TaskService with the REAL (pure) recurrence engine and a task-db stub
   * whose `findOne` returns the provided anchor (recurrence is the inline config
   * on the row). `taskDb.save` captures every saved entity in `savedTasks`: the
   * first is the OLD anchor (its config mutated to the UNTIL boundary in-place),
   * subsequent ones are the new master(s). `groupDbOverride` exercises the
   * cross-calendar group guard.
   */
  const buildSeamService = (
    anchor: Task,
    options: {
      groupDbOverride?: { findOneBy: jest.Mock };
    } = {},
  ) => {
    const engine = new RecurrenceRuleService();
    const savedTasks: Task[] = [];
    const taskDb = {
      findOne: jest.fn().mockResolvedValue(anchor),
      findOneBy: routedFindOneBy(anchor),
      findAllBy: jest.fn().mockResolvedValue([]),
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
      buildNotificationRuleService() as never,
      buildSyncStateService() as never,
    );

    return { service, engine, taskDb, savedTasks };
  };

  /**
   * The new master's inline config from a completed split: the LAST saved task is
   * the new anchor (the first save is the old anchor's in-place UNTIL mutation).
   */
  const newConfigOf = (savedTasks: Task[]): RecurrenceConfig =>
    savedTasks[savedTasks.length - 1].recurrenceConfig as RecurrenceConfig;

  it('splits off the inline config on the row (C1)', async () => {
    // Recurrence is inline on the row now — the split reads `recurrenceConfig`
    // straight off the anchor, ends it in-place, and gives the new master its own
    // config. Proof the split ran: old config ended, new config present + distinct.
    const anchor = makeTask({
      id: 'task-1',
      startAt: zoned('2026-06-01T09:00'),
      endAt: zoned('2026-06-01T09:30'),
      recurrenceConfig: makeRule({ frequency: RecurrenceFrequency.DAILY }),
    });
    const { service, savedTasks } = buildSeamService(anchor);

    const splitAt = zoned('2026-06-05T09:00');
    const newMaster = await service.splitSeries(
      'user-1',
      'task-1',
      splitAt,
      {},
    );

    // The old anchor's inline config was ended in-place (UNTIL the day before).
    expect(anchor.recurrenceConfig?.endType).toBe(RecurrenceEndType.UNTIL_DATE);
    // The new master carries its own (still-DAILY) inline config.
    expect(newMaster.recurrenceConfig?.frequency).toBe(
      RecurrenceFrequency.DAILY,
    );
    expect(newConfigOf(savedTasks).frequency).toBe(RecurrenceFrequency.DAILY);
  });

  it('leaves no gap and no overlap across a weekly single-weekday split', async () => {
    // Weekly on Monday (the anchor day). Split at a later Monday: old side keeps
    // the earlier Mondays, new side carries the rest — contiguous, disjoint.
    const rule = makeRule({
      frequency: RecurrenceFrequency.WEEKLY,
    });
    const anchorStart = zoned('2026-06-01T09:00'); // Monday
    const anchor = makeTask({
      id: 'task-1',
      startAt: anchorStart,
      endAt: zoned('2026-06-01T09:30'),
      recurrenceConfig: rule,
    });
    const { service, engine, savedTasks } = buildSeamService(anchor);

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

    // The OLD config is the anchor's now-UNTIL inline config; the NEW config is
    // the new master's inline config (last saved task).
    const oldConfig = anchor.recurrenceConfig as RecurrenceConfig;
    const newConfig = newConfigOf(savedTasks);

    const oldStarts = expandStarts(
      engine,
      oldConfig,
      anchorStart,
      30 * 60_000,
      WIDE_FROM,
      WIDE_TO,
    );
    const newStarts = expandStarts(
      engine,
      newConfig,
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
      frequency: RecurrenceFrequency.WEEKLY,
      byWeekday: [0, 3],
    });
    const anchorStart = zoned('2026-06-01T09:00'); // Monday
    const anchor = makeTask({
      id: 'task-1',
      startAt: anchorStart,
      endAt: zoned('2026-06-01T09:30'),
      recurrenceConfig: rule,
    });
    const { service, engine, savedTasks } = buildSeamService(anchor);

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

    const oldConfig = anchor.recurrenceConfig as RecurrenceConfig;
    const newConfig = newConfigOf(savedTasks);
    const oldStarts = expandStarts(
      engine,
      oldConfig,
      anchorStart,
      30 * 60_000,
      WIDE_FROM,
      WIDE_TO,
    );
    const newStarts = expandStarts(
      engine,
      newConfig,
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
      frequency: RecurrenceFrequency.DAILY,
      endType: RecurrenceEndType.UNTIL_DATE,
      endDate: '2026-06-30',
    });
    const anchorStart = zoned('2026-06-01T09:00');
    const anchor = makeTask({
      id: 'task-1',
      startAt: anchorStart,
      endAt: zoned('2026-06-01T09:30'),
      recurrenceConfig: rule,
    });
    const { service, engine, savedTasks } = buildSeamService(anchor);

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

    const oldConfig = anchor.recurrenceConfig as RecurrenceConfig;
    const newConfig = newConfigOf(savedTasks);

    // The new side inherits the original UNTIL date (clone), so the tail ends
    // where the original did — no occurrences invented past 2026-06-30.
    expect(newConfig.endType).toBe(RecurrenceEndType.UNTIL_DATE);
    expect(newConfig.endDate).toBe('2026-06-30');

    const oldStarts = expandStarts(
      engine,
      oldConfig,
      anchorStart,
      30 * 60_000,
      WIDE_FROM,
      WIDE_TO,
    );
    const newStarts = expandStarts(
      engine,
      newConfig,
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
      frequency: RecurrenceFrequency.DAILY,
      endType: RecurrenceEndType.COUNT,
      count: 10,
    });
    const anchorStart = zoned('2026-06-01T09:00');
    const anchor = makeTask({
      id: 'task-1',
      startAt: anchorStart,
      endAt: zoned('2026-06-01T09:30'),
      recurrenceConfig: rule,
    });
    const { service, engine, savedTasks } = buildSeamService(anchor);

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

    const oldConfig = anchor.recurrenceConfig as RecurrenceConfig;
    const newConfig = newConfigOf(savedTasks);

    // New count recomputed to 10 − 4 = 6.
    expect(newConfig.count).toBe(6);

    const oldStarts = expandStarts(
      engine,
      oldConfig,
      anchorStart,
      30 * 60_000,
      WIDE_FROM,
      WIDE_TO,
    );
    const newStarts = expandStarts(
      engine,
      newConfig,
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
      frequency: RecurrenceFrequency.DAILY,
    });
    const splitAt = zoned('2026-06-05T09:00');
    const anchor = makeTask({
      id: 'task-1',
      startAt: zoned('2026-06-01T09:00'),
      endAt: zoned('2026-06-01T09:30'),
      recurrenceConfig: rule,
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

    const engine = new RecurrenceRuleService();
    const taskDb = {
      findOne: jest.fn().mockResolvedValue(anchor),
      findOneBy: routedFindOneBy(anchor),
      findAllBy: jest.fn().mockResolvedValue([]),
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
      buildNotificationRuleService() as never,
      buildSyncStateService() as never,
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
      frequency: RecurrenceFrequency.DAILY,
    });
    const anchor = makeTask({
      id: 'task-1',
      calendarId: 'cal-1',
      startAt: zoned('2026-06-01T09:00'),
      endAt: zoned('2026-06-01T09:30'),
      recurrenceConfig: rule,
    });
    // The group resolves but lives in a DIFFERENT calendar.
    const groupDbOverride = {
      findOneBy: jest
        .fn()
        .mockResolvedValue({ id: 'grp-x', calendarId: 'other-cal' }),
    };
    const { service, savedTasks } = buildSeamService(anchor, {
      groupDbOverride,
    });

    await expect(
      service.splitSeries('user-1', 'task-1', zoned('2026-06-05T09:00'), {
        groupId: 'grp-x',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    // Nothing was written: the anchor's inline config is untouched (still NEVER)
    // and no task was saved. The guard ran before the first mutation.
    expect(anchor.recurrenceConfig?.endType).toBe(RecurrenceEndType.NEVER);
    expect(savedTasks).toHaveLength(0);
  });

  it('applies a same-calendar group atomically on the new master (C3)', async () => {
    const rule = makeRule({
      frequency: RecurrenceFrequency.DAILY,
    });
    const anchor = makeTask({
      id: 'task-1',
      calendarId: 'cal-1',
      startAt: zoned('2026-06-01T09:00'),
      endAt: zoned('2026-06-01T09:30'),
      recurrenceConfig: rule,
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

    // The group is set in the SAME createInstance — no follow-up update needed,
    // and the new master carries its own inline recurrence config.
    expect(taskDb.createInstance).toHaveBeenCalledWith(
      expect.objectContaining({
        groupId: 'grp-1',
        recurrenceConfig: expect.objectContaining({
          frequency: RecurrenceFrequency.DAILY,
        }),
      }),
    );
  });
});

describe('TaskService.endSeriesAt (T-3 delete this-and-following)', () => {
  /**
   * Wires a TaskService with the real (pure) engine so `endSeriesAt` truncates
   * against the actual UNTIL-date conversion. Recurrence is the inline config on
   * the row; `findOne` returns the anchor the service mutates and saves.
   */
  const buildService = (anchor: Task) => {
    const engine = new RecurrenceRuleService();
    const taskDb = {
      findOne: jest.fn().mockResolvedValue(anchor),
      findOneBy: routedFindOneBy(anchor),
      findAllBy: jest.fn().mockResolvedValue([]),
      createInstance: jest.fn((partial: Partial<Task>) => ({ ...partial })),
      save: jest.fn((entity: Task) => Promise.resolve(entity)),
    };
    const service = new TaskService(
      taskDb as never,
      buildCalendarDatabaseService() as never,
      buildGroupDatabaseService() as never,
      engine as never,
      buildExceptionService() as never,
      buildNotificationRuleService() as never,
      buildSyncStateService() as never,
    );

    return { service, engine, taskDb };
  };

  it('truncates the inline config at the day before the occurrence, preserving past ones', async () => {
    const anchorStart = zoned('2026-06-01T09:00');
    const anchor = makeTask({
      id: 'task-1',
      startAt: anchorStart,
      endAt: zoned('2026-06-01T09:30'),
      recurrenceConfig: makeRule({ frequency: RecurrenceFrequency.DAILY }),
    });
    const { service, engine, taskDb } = buildService(anchor);

    const cutAt = zoned('2026-06-05T09:00');

    await service.endSeriesAt('user-1', 'task-1', cutAt);

    // The inline config was converted to UNTIL_DATE the day before and saved on
    // the row — NOT a whole-series soft-delete (deletedAt is never stamped).
    const ended = anchor.recurrenceConfig as RecurrenceConfig;

    expect(ended.endType).toBe(RecurrenceEndType.UNTIL_DATE);
    expect(ended.endDate).toBe('2026-06-04');
    expect(anchor.deletedAt).toBeNull();
    expect(taskDb.save).toHaveBeenCalledTimes(1);

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
    const seriesStart = zoned('2026-06-01T09:00');
    const anchor = makeTask({
      id: 'task-1',
      startAt: seriesStart,
      endAt: zoned('2026-06-01T09:30'),
      recurrenceConfig: makeRule({ frequency: RecurrenceFrequency.DAILY }),
    });
    const { service, taskDb } = buildService(anchor);

    await service.endSeriesAt('user-1', 'task-1', seriesStart);

    // No past to keep — the whole task is soft-deleted, the config left untouched.
    expect(anchor.deletedAt).toBeInstanceOf(Date);
    expect(taskDb.save).toHaveBeenCalledTimes(1);
    expect(anchor.recurrenceConfig?.endType).toBe(RecurrenceEndType.NEVER);
  });

  it('soft-deletes a non-recurring task (no config to truncate)', async () => {
    const anchor = makeTask({ id: 'task-1', recurrenceConfig: null });
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
    const realEngine = new RecurrenceRuleService();
    const service = new TaskService(
      taskDb as never,
      calendarDb as never,
      buildGroupDatabaseService() as never,
      realEngine as never,
      exceptionService as never,
      buildNotificationRuleService() as never,
      buildSyncStateService() as never,
    );

    return { service, taskDb, exceptionService };
  };

  /**
   * Builds a TaskGroup with a default recurrence rule already attached.
   */
  const makeGroupWithRule = (
    groupId: string,
    config: RecurrenceConfig,
  ): TaskGroup =>
    ({
      id: groupId,
      calendarId: 'cal-1',
      name: 'Test Group',
      recurrenceConfig: config,
    }) as unknown as TaskGroup;

  it('expands a task that has no own rule via its group default rule', async () => {
    const groupRule = makeRule({
      frequency: RecurrenceFrequency.DAILY,
    });
    const group = makeGroupWithRule('group-1', groupRule);

    // A task with no own recurrenceConfig but assigned to a group with a default
    // config — it must expand using the group's config.
    const inherited = makeTask({
      id: 't-inherited',
      groupId: 'group-1',
      group,
      startAt: zoned('2026-06-01T09:00'),
      endAt: zoned('2026-06-01T09:30'),
      recurrenceConfig: null,
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
    // Each occurrence carries a GROUP-source summary naming the group + the
    // effective (inherited) rule, so a reader can render the inherited context.
    expect(
      result.every((occ) => occ.recurrence?.source === RecurrenceSource.GROUP),
    ).toBe(true);
    expect(result[0].recurrence?.groupName).toBe('Test Group');
    expect(result[0].recurrence?.config).toBe(groupRule);
  });

  it('does not double-count a group-inherited recurring task surfaced by both reads', async () => {
    // Regression: a real Postgres returns the SAME row from the one-off query
    // (`recurrenceConfig IS NULL`, no group filter) AND the group-inherited query.
    // The bucket-routed mock only exposes that overlap when the task is placed in
    // BOTH buckets — mirroring the DB. Before the fix this produced a phantom flat
    // one-off at the anchor PLUS the expanded series (8); it must be just 7.
    const groupRule = makeRule({
      frequency: RecurrenceFrequency.DAILY,
    });
    const group = makeGroupWithRule('group-1', groupRule);
    const inherited = makeTask({
      id: 't-inherited',
      groupId: 'group-1',
      group,
      startAt: zoned('2026-06-01T09:00'),
      endAt: zoned('2026-06-01T09:30'),
      recurrenceConfig: null,
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
      frequency: RecurrenceFrequency.DAILY,
    });
    const ownRule = makeRule({
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
      recurrenceConfig: ownRule,
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
    // The own rule wins, so the summary is TASK-sourced (no inherited group name)
    // and carries the task's own rule, not the group default.
    expect(result[0].recurrence?.source).toBe(RecurrenceSource.TASK);
    expect(result[0].recurrence?.groupName).toBeNull();
    expect(result[0].recurrence?.config).toBe(ownRule);
  });

  it('changing the group default changes expansion for tasks without own rules', async () => {
    const weeklyMonRule = makeRule({
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
      recurrenceConfig: null,
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
      frequency: RecurrenceFrequency.DAILY,
    });
    const groupWithDailyRule = makeGroupWithRule('group-1', dailyRule);
    const inheritedWithDaily = makeTask({
      id: 't-inherited',
      groupId: 'group-1',
      group: groupWithDailyRule,
      startAt: zoned('2026-06-01T09:00'),
      endAt: zoned('2026-06-01T09:30'),
      recurrenceConfig: null,
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
    // A group with NO default recurrence config.
    const groupNoRule = {
      id: 'group-1',
      calendarId: 'cal-1',
      recurrenceConfig: null,
    } as unknown as TaskGroup;

    const task = makeTask({
      id: 't-orphan',
      groupId: 'group-1',
      group: groupNoRule,
      startAt: zoned('2026-06-01T09:00'),
      recurrenceConfig: null,
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

describe('TaskService.getDailyCounts', () => {
  /**
   * Wires a TaskService with the REAL recurrence engine (pure) and a routed
   * task-database mock, so per-day bucketing is asserted over genuinely-expanded
   * occurrences. `calendarDbOverride` lets ownership tests swap the calendar stub.
   */
  const buildService = (
    fixtures: RangeFixtures,
    options: {
      exceptionService?: ReturnType<typeof buildExceptionService>;
      calendarDbOverride?: { findOneBy: jest.Mock; findAllByOwner: jest.Mock };
    } = {},
  ) => {
    const taskDb = { findAll: routedFindAll(fixtures) };
    const calendarDb =
      options.calendarDbOverride ?? buildCalendarDatabaseService();
    const realEngine = new RecurrenceRuleService();
    const service = new TaskService(
      taskDb as never,
      calendarDb as never,
      buildGroupDatabaseService() as never,
      realEngine as never,
      (options.exceptionService ?? buildExceptionService()) as never,
      buildNotificationRuleService() as never,
      buildSyncStateService() as never,
    );

    return { service, calendarDb };
  };

  it('keys counts by ISO local date in the task timezone', async () => {
    const oneOff = makeTask({
      id: 't-oneoff',
      startAt: zoned('2026-06-03T09:00'),
      endAt: zoned('2026-06-03T10:00'),
    });
    const { service } = buildService({ timedWithEnd: [oneOff] });

    const counts = await service.getDailyCounts(
      'user-1',
      WINDOW_FROM,
      WINDOW_TO,
      {
        calendarId: 'cal-1',
      },
    );

    expect(counts).toEqual({ '2026-06-03': 1 });
  });

  it('sums multiple occurrences landing on the same local date', async () => {
    const morning = makeTask({
      id: 't-am',
      startAt: zoned('2026-06-03T08:00'),
      endAt: zoned('2026-06-03T09:00'),
    });
    const evening = makeTask({
      id: 't-pm',
      startAt: zoned('2026-06-03T20:00'),
      endAt: zoned('2026-06-03T21:00'),
    });
    const otherDay = makeTask({
      id: 't-next',
      startAt: zoned('2026-06-04T08:00'),
      endAt: zoned('2026-06-04T09:00'),
    });
    const { service } = buildService({
      timedWithEnd: [morning, evening, otherDay],
    });

    const counts = await service.getDailyCounts(
      'user-1',
      WINDOW_FROM,
      WINDOW_TO,
      {
        calendarId: 'cal-1',
      },
    );

    expect(counts).toEqual({ '2026-06-03': 2, '2026-06-04': 1 });
  });

  it('counts each occurrence of a recurring series in its date bucket', async () => {
    const anchor = makeTask({
      id: 't-daily',
      startAt: zoned('2026-06-01T09:00'),
      endAt: zoned('2026-06-01T09:30'),
      recurrenceConfig: makeRule({ frequency: RecurrenceFrequency.DAILY }),
    });
    const { service } = buildService({ recurring: [anchor] });

    const counts = await service.getDailyCounts(
      'user-1',
      WINDOW_FROM,
      zoned('2026-06-04T00:00'),
      { calendarId: 'cal-1' },
    );

    // DAILY across [6/1, 6/4) → one occurrence each on 6/1, 6/2, 6/3.
    expect(counts).toEqual({
      '2026-06-01': 1,
      '2026-06-02': 1,
      '2026-06-03': 1,
    });
  });

  it('buckets a fall-back DST day to its wall-clock local date', async () => {
    // 2026-11-01 is the US fall-back day (02:00 EDT → 01:00 EST). A 09:00 local
    // occurrence must still bucket onto 2026-11-01 regardless of the offset jump.
    const dstOneOff = makeTask({
      id: 't-dst',
      startAt: zoned('2026-11-01T09:00'),
      endAt: zoned('2026-11-01T10:00'),
    });
    const { service } = buildService({ timedWithEnd: [dstOneOff] });

    const counts = await service.getDailyCounts(
      'user-1',
      zoned('2026-10-31T00:00'),
      zoned('2026-11-03T00:00'),
      { calendarId: 'cal-1' },
    );

    expect(counts).toEqual({ '2026-11-01': 1 });
  });

  it('excludes completed occurrences by default and includes them when asked', async () => {
    const completed = makeTask({
      id: 't-done',
      startAt: zoned('2026-06-02T09:00'),
      endAt: zoned('2026-06-02T10:00'),
      completedAt: zoned('2026-06-02T10:05'),
    });
    const open = makeTask({
      id: 't-open',
      startAt: zoned('2026-06-03T09:00'),
      endAt: zoned('2026-06-03T10:00'),
    });
    const fixtures = { timedWithEnd: [completed, open] };

    const { service } = buildService(fixtures);
    const defaultCounts = await service.getDailyCounts(
      'user-1',
      WINDOW_FROM,
      WINDOW_TO,
      { calendarId: 'cal-1' },
    );

    expect(defaultCounts).toEqual({ '2026-06-03': 1 });

    const { service: service2 } = buildService(fixtures);
    const withCompleted = await service2.getDailyCounts(
      'user-1',
      WINDOW_FROM,
      WINDOW_TO,
      { calendarId: 'cal-1', includeCompleted: true },
    );

    expect(withCompleted).toEqual({ '2026-06-02': 1, '2026-06-03': 1 });
  });

  it('omits zero-count days from the response', async () => {
    const sparse = makeTask({
      id: 't-sparse',
      startAt: zoned('2026-06-05T09:00'),
      endAt: zoned('2026-06-05T10:00'),
    });
    const { service } = buildService({ timedWithEnd: [sparse] });

    const counts = await service.getDailyCounts(
      'user-1',
      WINDOW_FROM,
      WINDOW_TO,
      {
        calendarId: 'cal-1',
      },
    );

    // Only the single populated day appears; every empty day is absent.
    expect(Object.keys(counts)).toEqual(['2026-06-05']);
  });

  it('rejects an empty window (delegated to findOccurrencesInRange)', async () => {
    const { service } = buildService({});

    await expect(
      service.getDailyCounts('user-1', WINDOW_TO, WINDOW_FROM, {
        calendarId: 'cal-1',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('throws 403 when the calendar belongs to another user', async () => {
    const calendarDbOverride = {
      findOneBy: jest.fn().mockResolvedValue({
        id: 'cal-1',
        ownerId: 'someone-else',
      } as Calendar),
      findAllByOwner: jest.fn().mockResolvedValue([]),
    };
    const { service } = buildService({}, { calendarDbOverride });

    await expect(
      service.getDailyCounts('user-1', WINDOW_FROM, WINDOW_TO, {
        calendarId: 'cal-1',
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('throws 404 when the calendar does not exist', async () => {
    const calendarDbOverride = {
      findOneBy: jest.fn().mockResolvedValue(null),
      findAllByOwner: jest.fn().mockResolvedValue([]),
    };
    const { service } = buildService({}, { calendarDbOverride });

    await expect(
      service.getDailyCounts('user-1', WINDOW_FROM, WINDOW_TO, {
        calendarId: 'missing-cal',
      }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

/**
 * Builds a TaskOccurrenceException with sensible defaults for delta tests.
 */
const makeException = (
  overrides: Partial<TaskOccurrenceException> = {},
): TaskOccurrenceException =>
  ({
    id: 'exc-1',
    taskId: 'task-1',
    originalStartAt: new Date('2026-06-20T10:00:00.000Z'),
    isSkipped: false,
    overrideStartAt: null,
    overrideEndAt: null,
    overrideTitle: null,
    completedAt: null,
    createdAt: new Date('2026-06-19T16:22:00.000Z'),
    updatedAt: new Date('2026-06-20T09:14:50.000Z'),
    ...overrides,
  }) as TaskOccurrenceException;

describe('TaskService.findChangedSince (delta endpoint)', () => {
  /**
   * Reads the `updatedAt`/`deletedAt` MoreThan boundary off a where clause, or
   * null when the field is absent.
   */
  const moreThanBoundary = (
    where: FindOptionsWhere<Task>,
    field: 'updatedAt' | 'deletedAt',
  ): Date | null => {
    const operand = where[field];

    if (operatorType(operand) !== 'moreThan') return null;

    return (operand as unknown as FindOperatorLike).value as Date;
  };

  /**
   * Routes the three reads `findChangedSince` issues off the where clause:
   * - `updatedAt: MoreThan` → changed series rows
   * - `deletedAt: MoreThan` (withDeleted) → soft-deleted rows
   * - bare `{ calendarId }` (id select) → the calendar's series-id rows
   */
  const routedChangedFindAll = (fixtures: {
    changed?: Task[];
    deleted?: Task[];
    seriesIds?: Task[];
  }) =>
    jest.fn((options?: FindManyOptions<Task>) => {
      const where = (options?.where ?? {}) as FindOptionsWhere<Task>;

      if (moreThanBoundary(where, 'updatedAt'))
        return Promise.resolve(fixtures.changed ?? []);

      if (options?.withDeleted || moreThanBoundary(where, 'deletedAt'))
        return Promise.resolve(fixtures.deleted ?? []);

      return Promise.resolve(fixtures.seriesIds ?? []);
    });

  /**
   * Wires a TaskService with routed task-db reads and a stub exception service
   * exposing `findChangedForTasks`. Calendar ownership resolves to user-1 / cal-1.
   */
  const buildService = (
    fixtures: {
      changed?: Task[];
      deleted?: Task[];
      seriesIds?: Task[];
      exceptions?: TaskOccurrenceException[];
    } = {},
    calendarDbOverride?: {
      findOneBy: jest.Mock;
      findAllByOwner: jest.Mock;
    },
  ) => {
    const findAll = routedChangedFindAll(fixtures);
    const taskDb = { findAll };
    const calendarDb = calendarDbOverride ?? buildCalendarDatabaseService();
    const exceptionService = {
      findChangedForTasks: jest
        .fn()
        .mockResolvedValue(fixtures.exceptions ?? []),
    };
    const service = new TaskService(
      taskDb as never,
      calendarDb as never,
      buildGroupDatabaseService() as never,
      new RecurrenceRuleService() as never,
      exceptionService as never,
      buildNotificationRuleService() as never,
      buildSyncStateService() as never,
    );

    return { service, findAll, exceptionService, calendarDb };
  };

  /**
   * Returns the `findAll` options object from the call matching `predicate`, or
   * throws if no such call was recorded — keeps each test's assertions free of
   * optional-chaining noise.
   */
  const findOptions = (
    findAll: jest.Mock,
    predicate: (options: FindManyOptions<Task>) => boolean,
  ): FindManyOptions<Task> => {
    const calls = findAll.mock.calls as Array<[FindManyOptions<Task>?]>;
    const match = calls.find((call) => predicate(call[0] ?? {}));

    if (!match || !match[0]) throw new Error('no matching findAll call');

    return match[0];
  };

  /**
   * Returns the where clause of the changed-series read (`updatedAt: MoreThan`).
   */
  const changedWhere = (findAll: jest.Mock): FindOptionsWhere<Task> =>
    (findOptions(findAll, (options) =>
      Boolean(
        moreThanBoundary(
          (options.where ?? {}) as FindOptionsWhere<Task>,
          'updatedAt',
        ),
      ),
    ).where ?? {}) as FindOptionsWhere<Task>;

  const SINCE = new Date('2026-06-20T12:00:00.000Z');
  // The delta reads widen the cursor by a 5s overlap lag to catch rows that
  // committed after the previous delta with an earlier timestamp (in-flight tx).
  const EFFECTIVE_SINCE = new Date(SINCE.getTime() - 5000);

  it('returns the changed series rows carrying their inline recurrence config', async () => {
    const changed = [makeTask({ id: 'task-1', recurrenceConfig: makeRule() })];
    const { service, findAll } = buildService({ changed });

    const result = await service.findChangedSince('user-1', SINCE, 'cal-1');

    expect(result.tasks).toEqual(changed);

    const changedOptions = findOptions(findAll, (options) =>
      Boolean(
        moreThanBoundary(
          (options.where ?? {}) as FindOptionsWhere<Task>,
          'updatedAt',
        ),
      ),
    );

    // Recurrence is the inline config on the row now — no relation to hydrate.
    expect(changedOptions.relations).toBeUndefined();
    expect(changedWhere(findAll).calendarId).toBe('cal-1');
  });

  it('returns soft-deleted series ids via a withDeleted read', async () => {
    const deleted = [
      makeTask({ id: 'task-old-1' }),
      makeTask({ id: 'task-old-2' }),
    ];
    const { service, findAll } = buildService({ deleted });

    const result = await service.findChangedSince('user-1', SINCE, 'cal-1');

    expect(result.deleted).toEqual(['task-old-1', 'task-old-2']);

    const deletedOptions = findOptions(
      findAll,
      (options) => options.withDeleted === true,
    );

    expect(
      moreThanBoundary(
        (deletedOptions.where ?? {}) as FindOptionsWhere<Task>,
        'deletedAt',
      ),
    ).toEqual(EFFECTIVE_SINCE);
  });

  it('returns changed exceptions scoped to the calendar series ids', async () => {
    const exceptions = [makeException({ id: 'exc-1' })];
    const seriesIds = [makeTask({ id: 'task-1' }), makeTask({ id: 'task-2' })];
    const { service, exceptionService } = buildService({
      exceptions,
      seriesIds,
    });

    const result = await service.findChangedSince('user-1', SINCE, 'cal-1');

    expect(result.exceptions).toEqual(exceptions);
    expect(exceptionService.findChangedForTasks).toHaveBeenCalledWith(
      ['task-1', 'task-2'],
      EFFECTIVE_SINCE,
    );
  });

  it('applies the 5s overlap lag to the changed / deleted lower bound', async () => {
    const { service, findAll } = buildService({});

    await service.findChangedSince('user-1', SINCE, 'cal-1');

    expect(moreThanBoundary(changedWhere(findAll), 'updatedAt')).toEqual(
      EFFECTIVE_SINCE,
    );
  });

  it('skips all reads on the first call (since=null) and returns only the cursor', async () => {
    const { service, findAll, exceptionService } = buildService({});

    const result = await service.findChangedSince('user-1', null, 'cal-1');

    expect(result.tasks).toEqual([]);
    expect(result.deleted).toEqual([]);
    expect(result.exceptions).toEqual([]);
    expect(result.serverTime).toBeInstanceOf(Date);
    expect(findAll).not.toHaveBeenCalled();
    expect(exceptionService.findChangedForTasks).not.toHaveBeenCalled();
  });

  it('returns a server-clock cursor (serverTime) on a delta call', async () => {
    const before = Date.now();
    const { service } = buildService({});

    const result = await service.findChangedSince('user-1', SINCE, 'cal-1');

    expect(result.serverTime).toBeInstanceOf(Date);
    expect(result.serverTime.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('excludes todos from the changed set when includeTodos is false', async () => {
    const { service, findAll } = buildService({});

    await service.findChangedSince('user-1', SINCE, 'cal-1', {
      includeTodos: false,
    });

    expect(operatorType(changedWhere(findAll).startAt)).toBe('not');
  });

  it('includes todos by default (no startAt constraint on the changed read)', async () => {
    const { service, findAll } = buildService({});

    await service.findChangedSince('user-1', SINCE, 'cal-1');

    expect(changedWhere(findAll).startAt).toBeUndefined();
  });

  it('throws 403 when the calendar belongs to another user', async () => {
    const calendarDbOverride = {
      findOneBy: jest.fn().mockResolvedValue({
        id: 'cal-1',
        ownerId: 'someone-else',
      } as Calendar),
      findAllByOwner: jest.fn().mockResolvedValue([]),
    };
    const { service } = buildService({}, calendarDbOverride);

    await expect(
      service.findChangedSince('user-1', SINCE, 'cal-1'),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('throws 404 when the calendar does not exist', async () => {
    const calendarDbOverride = {
      findOneBy: jest.fn().mockResolvedValue(null),
      findAllByOwner: jest.fn().mockResolvedValue([]),
    };
    const { service } = buildService({}, calendarDbOverride);

    await expect(
      service.findChangedSince('user-1', SINCE, 'missing-cal'),
    ).rejects.toMatchObject({ status: 404 });
  });
});

/**
 * PROOF: the write boundary interprets a NAIVE wall-clock ISO (no offset, as the
 * AI model emits) in the task's timezone — NOT as UTC. With the process tz forced
 * to UTC (mirroring the prod server) and zone "Europe/Moscow" (UTC+3), a naive
 * "14:30" must persist as 11:30Z, and a string carrying an explicit offset must
 * keep that offset. Asserting on absolute UTC instants is tz-independent, but the
 * forced TZ pins the regression: the old `new Date(naive)` would store 14:30Z.
 */
describe('TaskService write-boundary timezone interpretation', () => {
  const ZONE = 'Europe/Moscow';
  const NAIVE = '2026-06-25T14:30:00';
  const WITH_OFFSET = '2026-06-25T14:30:00+03:00';
  // Both naive-in-Moscow and the +03:00 string denote the SAME instant: 11:30Z.
  const EXPECTED_UTC = '2026-06-25T11:30:00.000Z';

  let originalTz: string | undefined;

  beforeAll(() => {
    originalTz = process.env.TZ;
    process.env.TZ = 'UTC';
  });

  afterAll(() => {
    process.env.TZ = originalTz;
  });

  /**
   * Builds a TaskService over a single mutable task fixture with mocked write
   * collaborators (createInstance/save/findOne), covering create + update + split.
   */
  const buildService = (task?: Task) => {
    const taskDb = {
      createInstance: jest.fn((partial: Partial<Task>) => ({ ...partial })),
      save: jest.fn((entity: Task) =>
        Promise.resolve({ ...entity, id: entity.id ?? 'task-1' }),
      ),
      findOneBy: routedFindOneBy(task ?? null),
      findOne: jest.fn().mockResolvedValue(task ?? null),
      findAllBy: jest.fn().mockResolvedValue([]),
    };
    const service = new TaskService(
      taskDb as never,
      buildCalendarDatabaseService() as never,
      buildGroupDatabaseService() as never,
      new RecurrenceRuleService() as never,
      buildExceptionService() as never,
      buildNotificationRuleService() as never,
      buildSyncStateService() as never,
    );

    return { service, taskDb };
  };

  describe('create', () => {
    it('stores a naive wall-clock as the zoned instant (11:30Z, NOT 14:30Z)', async () => {
      const { service } = buildService();

      const created = await service.create('user-1', {
        calendarId: 'cal-1',
        title: 'Standup',
        timezone: ZONE,
        startAt: NAIVE,
        endAt: NAIVE,
      });

      expect(created.startAt?.toISOString()).toBe(EXPECTED_UTC);
      expect(created.endAt?.toISOString()).toBe(EXPECTED_UTC);
    });

    it('honors an explicit in-string offset (+03:00 ⇒ 11:30Z)', async () => {
      const { service } = buildService();

      const created = await service.create('user-1', {
        calendarId: 'cal-1',
        title: 'Standup',
        timezone: ZONE,
        startAt: WITH_OFFSET,
      });

      expect(created.startAt?.toISOString()).toBe(EXPECTED_UTC);
    });
  });

  describe('update (one-off / all scope)', () => {
    it('localizes a naive move in the next timezone (11:30Z)', async () => {
      const task = makeTask({ id: 'task-1', timezone: ZONE });
      const { service } = buildService(task);

      const updated = await service.update('user-1', 'task-1', {
        startAt: NAIVE,
        endAt: NAIVE,
        timezone: ZONE,
      });

      expect(updated.startAt?.toISOString()).toBe(EXPECTED_UTC);
      expect(updated.endAt?.toISOString()).toBe(EXPECTED_UTC);
      expect(updated.timezone).toBe(ZONE);
    });

    it('honors an explicit offset on update (+03:00 ⇒ 11:30Z)', async () => {
      const task = makeTask({ id: 'task-1', timezone: ZONE });
      const { service } = buildService(task);

      const updated = await service.update('user-1', 'task-1', {
        startAt: WITH_OFFSET,
        timezone: ZONE,
      });

      expect(updated.startAt?.toISOString()).toBe(EXPECTED_UTC);
    });

    it('updates a RECURRING anchor (the all scope) with a naive move ⇒ 11:30Z', async () => {
      const task = makeTask({
        id: 'task-1',
        timezone: ZONE,
        startAt: zoned('2026-06-01T09:00', ZONE),
        endAt: zoned('2026-06-01T09:30', ZONE),
        recurrenceConfig: makeRule({ frequency: RecurrenceFrequency.DAILY }),
      });
      const { service } = buildService(task);

      const updated = await service.update('user-1', 'task-1', {
        startAt: NAIVE,
        endAt: NAIVE,
        timezone: ZONE,
      });

      // The master anchor's instant is the zoned wall-clock; the inline config is
      // untouched, so the whole series re-anchors to the correct instant.
      expect(updated.startAt?.toISOString()).toBe(EXPECTED_UTC);
      expect(updated.recurrenceConfig).toEqual(
        makeRule({ frequency: RecurrenceFrequency.DAILY }),
      );
    });
  });

  describe('splitSeries (this_and_following scope)', () => {
    it('anchors the new master at the zoned naive instant (11:30Z)', async () => {
      const anchor = makeTask({
        id: 'task-1',
        timezone: ZONE,
        startAt: zoned('2026-06-01T09:00', ZONE),
        endAt: zoned('2026-06-01T09:30', ZONE),
        recurrenceConfig: makeRule({ frequency: RecurrenceFrequency.DAILY }),
      });
      const { service, taskDb } = buildService(anchor);

      const originalStart = zoned('2026-06-25T09:00', ZONE);

      await service.splitSeries('user-1', 'task-1', originalStart, {
        startAt: NAIVE,
        timezone: ZONE,
      });

      // The new master is the LAST createInstance call; its startAt is the zoned
      // naive instant, not 14:30Z.
      const newMaster = taskDb.createInstance.mock.calls.at(-1)?.[0] as Task;

      expect(newMaster.startAt?.toISOString()).toBe(EXPECTED_UTC);
      expect(newMaster.timezone).toBe(ZONE);
    });
  });
});
