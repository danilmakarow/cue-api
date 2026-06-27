import { Logger } from '@nestjs/common';
import { DateTime } from 'luxon';

import { RecurrenceRuleService } from './recurrence-rule.service';
import {
  MonthlyAnchorMode,
  Occurrence,
  RecurrenceConfig,
  RecurrenceSource,
} from './recurrence.types';
import {
  RecurrenceEndType,
  RecurrenceFrequency,
  Task,
  TaskOccurrenceException,
} from '@/modules/database/entities';

/**
 * Builds a Task anchor with sensible recurring-event defaults for the engine
 * tests. Only the fields the expander reads need to be realistic.
 */
const makeTask = (overrides: Partial<Task> = {}): Task =>
  ({
    id: 'task-1',
    title: 'Anchor',
    timezone: 'America/New_York',
    startAt: null,
    endAt: null,
    isAllDay: false,
    completedAt: null,
    ...overrides,
  }) as Task;

/**
 * Builds a RecurrenceConfig with NEVER/interval-1 defaults, overridable per test.
 * The engine now takes the inline config POJO (no persisted rule / id).
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
 * Builds a TaskOccurrenceException for a given original-start instant.
 */
const makeException = (
  originalStartAt: Date,
  overrides: Partial<TaskOccurrenceException> = {},
): TaskOccurrenceException =>
  ({
    id: `exc-${originalStartAt.toISOString()}`,
    taskId: 'task-1',
    originalStartAt,
    isSkipped: false,
    overrideStartAt: null,
    overrideEndAt: null,
    overrideTitle: null,
    completedAt: null,
    ...overrides,
  }) as TaskOccurrenceException;

/**
 * Converts a wall-clock spec in a zone to the UTC instant a `Task.startAt`
 * column would hold.
 */
const zoned = (iso: string, zone = 'America/New_York'): Date =>
  DateTime.fromISO(iso, { zone }).toJSDate();

/**
 * Returns the local wall-clock hour of an instant in the given zone. Accepts the
 * now-nullable `Occurrence` start fields; every recurring occurrence under test
 * carries a real `Date`.
 */
const localHour = (date: Date | null, zone: string): number =>
  DateTime.fromJSDate(date as Date, { zone }).hour;

/**
 * Returns the ISO date (yyyy-mm-dd) of an instant in the given zone. Accepts the
 * now-nullable `Occurrence` start fields; every recurring occurrence under test
 * carries a real `Date`.
 */
const localDate = (date: Date | null, zone: string): string =>
  DateTime.fromJSDate(date as Date, { zone }).toISODate() as string;

describe('RecurrenceRuleService.expandOccurrences', () => {
  let service: RecurrenceRuleService;

  beforeEach(() => {
    // The expander is pure and carries no DB dependency (ADR 0054).
    service = new RecurrenceRuleService();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('frequencies', () => {
    it('expands a DAILY rule across the window', () => {
      const anchor = makeTask({ startAt: zoned('2026-06-01T09:00') });
      const rule = makeRule({ frequency: RecurrenceFrequency.DAILY });

      const result = service.expandOccurrences(
        anchor,
        rule,
        [],
        zoned('2026-06-01T00:00'),
        zoned('2026-06-05T00:00'),
      );

      expect(
        result.map((occ) => localDate(occ.occurrenceStart, anchor.timezone)),
      ).toEqual(['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04']);
      expect(result[0].isRecurring).toBe(true);
      expect(result[0].isException).toBe(false);
    });

    it('expands a WEEKLY rule on the seed weekday', () => {
      const anchor = makeTask({ startAt: zoned('2026-06-01T09:00') }); // Monday
      const rule = makeRule({ frequency: RecurrenceFrequency.WEEKLY });

      const result = service.expandOccurrences(
        anchor,
        rule,
        [],
        zoned('2026-06-01T00:00'),
        zoned('2026-06-29T00:00'),
      );

      expect(
        result.map((occ) => localDate(occ.occurrenceStart, anchor.timezone)),
      ).toEqual(['2026-06-01', '2026-06-08', '2026-06-15', '2026-06-22']);
    });

    it('expands a MONTHLY rule on the seed day-of-month', () => {
      const anchor = makeTask({ startAt: zoned('2026-01-15T09:00') });
      const rule = makeRule({ frequency: RecurrenceFrequency.MONTHLY });

      const result = service.expandOccurrences(
        anchor,
        rule,
        [],
        zoned('2026-01-01T00:00'),
        zoned('2026-05-01T00:00'),
      );

      expect(
        result.map((occ) => localDate(occ.occurrenceStart, anchor.timezone)),
      ).toEqual(['2026-01-15', '2026-02-15', '2026-03-15', '2026-04-15']);
    });

    it('expands a YEARLY rule on the seed month and day', () => {
      const anchor = makeTask({ startAt: zoned('2026-07-04T09:00') });
      const rule = makeRule({ frequency: RecurrenceFrequency.YEARLY });

      const result = service.expandOccurrences(
        anchor,
        rule,
        [],
        zoned('2026-01-01T00:00'),
        zoned('2029-01-01T00:00'),
      );

      expect(
        result.map((occ) => localDate(occ.occurrenceStart, anchor.timezone)),
      ).toEqual(['2026-07-04', '2027-07-04', '2028-07-04']);
    });
  });

  describe('interval > 1', () => {
    it('steps a WEEKLY rule every two weeks', () => {
      const anchor = makeTask({ startAt: zoned('2026-06-01T09:00') });
      const rule = makeRule({
        frequency: RecurrenceFrequency.WEEKLY,
        interval: 2,
      });

      const result = service.expandOccurrences(
        anchor,
        rule,
        [],
        zoned('2026-06-01T00:00'),
        zoned('2026-07-13T00:00'), // half-open: the 2026-07-13 instance is excluded
      );

      expect(
        result.map((occ) => localDate(occ.occurrenceStart, anchor.timezone)),
      ).toEqual(['2026-06-01', '2026-06-15', '2026-06-29']);
    });

    it('steps a DAILY rule every three days', () => {
      const anchor = makeTask({ startAt: zoned('2026-06-01T09:00') });
      const rule = makeRule({
        frequency: RecurrenceFrequency.DAILY,
        interval: 3,
      });

      const result = service.expandOccurrences(
        anchor,
        rule,
        [],
        zoned('2026-06-01T00:00'),
        zoned('2026-06-12T00:00'),
      );

      expect(
        result.map((occ) => localDate(occ.occurrenceStart, anchor.timezone)),
      ).toEqual(['2026-06-01', '2026-06-04', '2026-06-07', '2026-06-10']);
    });
  });

  describe('by* filters', () => {
    it('expands WEEKLY byWeekday into every listed weekday (0=Mon mapping)', () => {
      const anchor = makeTask({ startAt: zoned('2026-06-01T09:00') }); // Monday
      // 0=Mon, 2=Wed, 4=Fri — the canonical "every weekday-ish" expansion.
      const rule = makeRule({
        frequency: RecurrenceFrequency.WEEKLY,
        byWeekday: [0, 2, 4],
      });

      const result = service.expandOccurrences(
        anchor,
        rule,
        [],
        zoned('2026-06-01T00:00'),
        zoned('2026-06-13T00:00'),
      );

      expect(
        result.map((occ) => localDate(occ.occurrenceStart, anchor.timezone)),
      ).toEqual([
        '2026-06-01', // Mon
        '2026-06-03', // Wed
        '2026-06-05', // Fri
        '2026-06-08', // Mon
        '2026-06-10', // Wed
        '2026-06-12', // Fri
      ]);
    });

    it('expands WEEKLY byWeekday=[4] (Friday) and never the seed Monday', () => {
      const anchor = makeTask({ startAt: zoned('2026-06-01T09:00') }); // Monday
      const rule = makeRule({
        frequency: RecurrenceFrequency.WEEKLY,
        byWeekday: [4], // Friday only
      });

      const result = service.expandOccurrences(
        anchor,
        rule,
        [],
        zoned('2026-06-01T00:00'),
        zoned('2026-06-20T00:00'),
      );

      const weekdays = result.map(
        (occ) =>
          DateTime.fromJSDate(occ.occurrenceStart as Date, {
            zone: anchor.timezone,
          }).weekday,
      );

      expect(weekdays.every((weekday) => weekday === 5)).toBe(true); // luxon Fri = 5
      expect(
        result.map((occ) => localDate(occ.occurrenceStart, anchor.timezone)),
      ).toEqual(['2026-06-05', '2026-06-12', '2026-06-19']);
    });

    it('expands MONTHLY byMonthDay into multiple days per month', () => {
      const anchor = makeTask({ startAt: zoned('2026-01-01T09:00') });
      const rule = makeRule({
        frequency: RecurrenceFrequency.MONTHLY,
        byMonthDay: [1, 15],
      });

      const result = service.expandOccurrences(
        anchor,
        rule,
        [],
        zoned('2026-01-01T00:00'),
        zoned('2026-03-01T00:00'),
      );

      expect(
        result.map((occ) => localDate(occ.occurrenceStart, anchor.timezone)),
      ).toEqual(['2026-01-01', '2026-01-15', '2026-02-01', '2026-02-15']);
    });

    it('expands YEARLY byMonth into multiple months per year', () => {
      const anchor = makeTask({ startAt: zoned('2026-03-10T09:00') });
      const rule = makeRule({
        frequency: RecurrenceFrequency.YEARLY,
        byMonth: [3, 9],
      });

      const result = service.expandOccurrences(
        anchor,
        rule,
        [],
        zoned('2026-01-01T00:00'),
        zoned('2027-12-31T00:00'),
      );

      expect(
        result.map((occ) => localDate(occ.occurrenceStart, anchor.timezone)),
      ).toEqual(['2026-03-10', '2026-09-10', '2027-03-10', '2027-09-10']);
    });

    it('treats byMonth as a limiting filter under DAILY', () => {
      const anchor = makeTask({ startAt: zoned('2026-01-30T09:00') });
      const rule = makeRule({
        frequency: RecurrenceFrequency.DAILY,
        byMonth: [2], // only February days survive
      });

      const result = service.expandOccurrences(
        anchor,
        rule,
        [],
        zoned('2026-01-30T00:00'),
        zoned('2026-03-03T00:00'),
      );

      const months = new Set(
        result.map(
          (occ) =>
            DateTime.fromJSDate(occ.occurrenceStart as Date, {
              zone: anchor.timezone,
            }).month,
        ),
      );

      expect(months).toEqual(new Set([2]));
      expect(result).toHaveLength(28); // Feb 2026 has 28 days
    });
  });

  describe('endType termination', () => {
    it('NEVER clips to the window only', () => {
      const anchor = makeTask({ startAt: zoned('2026-06-01T09:00') });
      const rule = makeRule({
        frequency: RecurrenceFrequency.DAILY,
        endType: RecurrenceEndType.NEVER,
      });

      const result = service.expandOccurrences(
        anchor,
        rule,
        [],
        zoned('2026-06-10T00:00'),
        zoned('2026-06-13T00:00'),
      );

      // Series began 2026-06-01 but only in-window days surface.
      expect(
        result.map((occ) => localDate(occ.occurrenceStart, anchor.timezone)),
      ).toEqual(['2026-06-10', '2026-06-11', '2026-06-12']);
    });

    it('UNTIL_DATE stops at the inclusive end date', () => {
      const anchor = makeTask({ startAt: zoned('2026-06-01T09:00') });
      const rule = makeRule({
        frequency: RecurrenceFrequency.DAILY,
        endType: RecurrenceEndType.UNTIL_DATE,
        endDate: '2026-06-03',
      });

      const result = service.expandOccurrences(
        anchor,
        rule,
        [],
        zoned('2026-06-01T00:00'),
        zoned('2026-06-30T00:00'),
      );

      expect(
        result.map((occ) => localDate(occ.occurrenceStart, anchor.timezone)),
      ).toEqual(['2026-06-01', '2026-06-02', '2026-06-03']);
    });

    it('COUNT counts from the series origin, independent of the window', () => {
      const anchor = makeTask({ startAt: zoned('2026-06-01T09:00') });
      const rule = makeRule({
        frequency: RecurrenceFrequency.DAILY,
        endType: RecurrenceEndType.COUNT,
        count: 5,
      });

      // Window opens on day 3; only counted instances 3,4,5 remain (1 and 2
      // consumed their count but fall before the window).
      const result = service.expandOccurrences(
        anchor,
        rule,
        [],
        zoned('2026-06-03T00:00'),
        zoned('2026-06-30T00:00'),
      );

      expect(
        result.map((occ) => localDate(occ.occurrenceStart, anchor.timezone)),
      ).toEqual(['2026-06-03', '2026-06-04', '2026-06-05']);
    });

    it('COUNT caps the total generated occurrences within a wide window', () => {
      const anchor = makeTask({ startAt: zoned('2026-06-01T09:00') });
      const rule = makeRule({
        frequency: RecurrenceFrequency.DAILY,
        endType: RecurrenceEndType.COUNT,
        count: 3,
      });

      const result = service.expandOccurrences(
        anchor,
        rule,
        [],
        zoned('2026-06-01T00:00'),
        zoned('2026-12-31T00:00'),
      );

      expect(result).toHaveLength(3);
    });
  });

  describe('DST boundaries', () => {
    const zone = 'America/New_York';

    it('keeps wall-clock 09:00 across the spring-forward transition', () => {
      // 2026-03-08 is the US spring-forward (02:00 -> 03:00).
      const anchor = makeTask({
        timezone: zone,
        startAt: zoned('2026-03-06T09:00', zone),
      });
      const rule = makeRule({ frequency: RecurrenceFrequency.DAILY });

      const result = service.expandOccurrences(
        anchor,
        rule,
        [],
        zoned('2026-03-06T00:00', zone),
        zoned('2026-03-11T00:00', zone),
      );

      const dateToHour = result.map((occ) => [
        localDate(occ.occurrenceStart, zone),
        localHour(occ.occurrenceStart, zone),
      ]);

      expect(dateToHour).toEqual([
        ['2026-03-06', 9],
        ['2026-03-07', 9],
        ['2026-03-08', 9], // transition day — still 09:00 local
        ['2026-03-09', 9],
        ['2026-03-10', 9],
      ]);

      // The UTC offset actually changed across the boundary.
      const offsetBefore = DateTime.fromJSDate(
        result[0].occurrenceStart as Date,
        {
          zone,
        },
      ).offset;
      const offsetAfter = DateTime.fromJSDate(
        result[4].occurrenceStart as Date,
        {
          zone,
        },
      ).offset;

      expect(offsetAfter - offsetBefore).toBe(60); // gained an hour of offset
    });

    it('keeps wall-clock 09:00 across the fall-back transition (weekly)', () => {
      // 2026-11-01 is the US fall-back (02:00 -> 01:00).
      const anchor = makeTask({
        timezone: zone,
        startAt: zoned('2026-10-25T09:00', zone), // Sunday
      });
      const rule = makeRule({ frequency: RecurrenceFrequency.WEEKLY });

      const result = service.expandOccurrences(
        anchor,
        rule,
        [],
        zoned('2026-10-25T00:00', zone),
        zoned('2026-11-16T00:00', zone),
      );

      const dateToHour = result.map((occ) => [
        localDate(occ.occurrenceStart, zone),
        localHour(occ.occurrenceStart, zone),
      ]);

      expect(dateToHour).toEqual([
        ['2026-10-25', 9],
        ['2026-11-01', 9], // transition day — still 09:00 local
        ['2026-11-08', 9],
        ['2026-11-15', 9],
      ]);

      const offsetBefore = DateTime.fromJSDate(
        result[0].occurrenceStart as Date,
        {
          zone,
        },
      ).offset;
      const offsetAfter = DateTime.fromJSDate(
        result[3].occurrenceStart as Date,
        {
          zone,
        },
      ).offset;

      expect(offsetAfter - offsetBefore).toBe(-60); // lost an hour of offset
    });
  });

  describe('month-overflow clamping', () => {
    it('skips months without a 31st for a MONTHLY day-31 rule', () => {
      const anchor = makeTask({ startAt: zoned('2026-01-31T09:00') });
      const rule = makeRule({ frequency: RecurrenceFrequency.MONTHLY });

      const result = service.expandOccurrences(
        anchor,
        rule,
        [],
        zoned('2026-01-01T00:00'),
        zoned('2026-08-01T00:00'),
      );

      // Feb (28), Apr (30), Jun (30) have no 31st and are skipped — never clamped.
      expect(
        result.map((occ) => localDate(occ.occurrenceStart, anchor.timezone)),
      ).toEqual(['2026-01-31', '2026-03-31', '2026-05-31', '2026-07-31']);
    });

    it('skips non-leap Feb 29 for a YEARLY Feb-29 rule', () => {
      const anchor = makeTask({ startAt: zoned('2024-02-29T09:00') }); // 2024 is a leap year
      const rule = makeRule({ frequency: RecurrenceFrequency.YEARLY });

      const result = service.expandOccurrences(
        anchor,
        rule,
        [],
        zoned('2024-01-01T00:00'),
        zoned('2029-12-31T00:00'),
      );

      // Only leap years (2024, 2028) have Feb 29.
      expect(
        result.map((occ) => localDate(occ.occurrenceStart, anchor.timezone)),
      ).toEqual(['2024-02-29', '2028-02-29']);
    });
  });

  describe('advanced monthly (S3): nth-weekday via bySetPos', () => {
    it('expands "first Monday" of each month', () => {
      // Anchor on the first Monday of Jun 2026 (2026-06-01 is itself a Monday).
      const anchor = makeTask({ startAt: zoned('2026-06-01T09:00') });
      const rule = makeRule({
        frequency: RecurrenceFrequency.MONTHLY,
        byWeekday: [0],
        bySetPos: [1],
      });

      const result = service.expandOccurrences(
        anchor,
        rule,
        [],
        zoned('2026-06-01T00:00'),
        zoned('2026-10-01T00:00'),
      );

      // First Mondays: Jun 1, Jul 6, Aug 3, Sep 7.
      expect(
        result.map((occ) => localDate(occ.occurrenceStart, anchor.timezone)),
      ).toEqual(['2026-06-01', '2026-07-06', '2026-08-03', '2026-09-07']);
      expect(localHour(result[0].occurrenceStart, anchor.timezone)).toBe(9);
    });

    it('expands "second Tuesday" of each month', () => {
      const anchor = makeTask({ startAt: zoned('2026-06-09T08:30') }); // 2nd Tue of Jun
      const rule = makeRule({
        frequency: RecurrenceFrequency.MONTHLY,
        byWeekday: [1],
        bySetPos: [2],
      });

      const result = service.expandOccurrences(
        anchor,
        rule,
        [],
        zoned('2026-06-01T00:00'),
        zoned('2026-09-01T00:00'),
      );

      // Second Tuesdays: Jun 9, Jul 14, Aug 11.
      expect(
        result.map((occ) => localDate(occ.occurrenceStart, anchor.timezone)),
      ).toEqual(['2026-06-09', '2026-07-14', '2026-08-11']);
    });

    it('expands "last Friday" of each month, honoring 4- vs 5-Friday months', () => {
      const anchor = makeTask({ startAt: zoned('2026-01-30T17:00') }); // last Fri of Jan
      const rule = makeRule({
        frequency: RecurrenceFrequency.MONTHLY,
        byWeekday: [4],
        bySetPos: [-1],
      });

      const result = service.expandOccurrences(
        anchor,
        rule,
        [],
        zoned('2026-01-01T00:00'),
        zoned('2026-05-01T00:00'),
      );

      // Last Fridays: Jan 30, Feb 27, Mar 27, Apr 24.
      expect(
        result.map((occ) => localDate(occ.occurrenceStart, anchor.timezone)),
      ).toEqual(['2026-01-30', '2026-02-27', '2026-03-27', '2026-04-24']);
    });

    it('drops a 5th-weekday ordinal in months with only four (never clamps)', () => {
      // 5 Mondays exist in Jun 2026 (1,8,15,22,29); anchor on the 5th Monday.
      const anchor = makeTask({ startAt: zoned('2026-06-29T09:00') });
      const rule = makeRule({
        frequency: RecurrenceFrequency.MONTHLY,
        byWeekday: [0],
        // 5 is past the DTO-validated 1..4/-1 set, but the engine still treats
        // any overflowing ordinal as "skip", never clamping to the 4th.
        bySetPos: [5],
      });

      const result = service.expandOccurrences(
        anchor,
        rule,
        [],
        zoned('2026-06-01T00:00'),
        zoned('2026-12-01T00:00'),
      );

      // Only months WITH a 5th Monday yield an occurrence: Jun (29), Aug (31),
      // Nov (30). Months with four Mondays are skipped, not clamped to the 4th.
      expect(
        result.map((occ) => localDate(occ.occurrenceStart, anchor.timezone)),
      ).toEqual(['2026-06-29', '2026-08-31', '2026-11-30']);
    });

    it('honors interval > 1 with a nth-weekday rule', () => {
      const anchor = makeTask({ startAt: zoned('2026-06-01T09:00') }); // 1st Mon
      const rule = makeRule({
        frequency: RecurrenceFrequency.MONTHLY,
        interval: 2,
        byWeekday: [0],
        bySetPos: [1],
      });

      const result = service.expandOccurrences(
        anchor,
        rule,
        [],
        zoned('2026-06-01T00:00'),
        zoned('2026-12-01T00:00'),
      );

      // Every 2nd month's first Monday: Jun 1, Aug 3, Oct 5.
      expect(
        result.map((occ) => localDate(occ.occurrenceStart, anchor.timezone)),
      ).toEqual(['2026-06-01', '2026-08-03', '2026-10-05']);
    });
  });

  describe('advanced monthly (S3): working-day anchor', () => {
    it('expands the FIRST working day of each month (skipping weekends)', () => {
      // Aug 2026 starts on Sat (1st) / Sun (2nd); first workday is Mon Aug 3.
      const anchor = makeTask({ startAt: zoned('2026-08-03T09:00') });
      const rule = makeRule({
        frequency: RecurrenceFrequency.MONTHLY,
        monthlyAnchor: MonthlyAnchorMode.FIRST_WORKDAY,
      });

      const result = service.expandOccurrences(
        anchor,
        rule,
        [],
        zoned('2026-08-01T00:00'),
        zoned('2026-12-01T00:00'),
      );

      // Aug 1/2 are Sat/Sun → Aug 3; Sep 1 Tue; Oct 1 Thu; Nov 1 Sun → Nov 2 Mon.
      expect(
        result.map((occ) => localDate(occ.occurrenceStart, anchor.timezone)),
      ).toEqual(['2026-08-03', '2026-09-01', '2026-10-01', '2026-11-02']);
      expect(localHour(result[0].occurrenceStart, anchor.timezone)).toBe(9);
    });

    it('expands the LAST working day of each month (skipping weekends)', () => {
      // May 2026: 31st is Sun, 30th Sat → last workday Fri May 29.
      const anchor = makeTask({ startAt: zoned('2026-05-29T17:00') });
      const rule = makeRule({
        frequency: RecurrenceFrequency.MONTHLY,
        monthlyAnchor: MonthlyAnchorMode.LAST_WORKDAY,
      });

      const result = service.expandOccurrences(
        anchor,
        rule,
        [],
        zoned('2026-05-01T00:00'),
        zoned('2026-09-01T00:00'),
      );

      // May 29 (Fri), Jun 30 (Tue), Jul 31 (Fri), Aug 31 (Mon).
      expect(
        result.map((occ) => localDate(occ.occurrenceStart, anchor.timezone)),
      ).toEqual(['2026-05-29', '2026-06-30', '2026-07-31', '2026-08-31']);
    });

    it('expands the DAY BEFORE the last working day of each month', () => {
      // May 2026 last workday is Fri 29 → day before is Thu May 28.
      const anchor = makeTask({ startAt: zoned('2026-05-28T09:00') });
      const rule = makeRule({
        frequency: RecurrenceFrequency.MONTHLY,
        monthlyAnchor: MonthlyAnchorMode.DAY_BEFORE_LAST_WORKDAY,
      });

      const result = service.expandOccurrences(
        anchor,
        rule,
        [],
        zoned('2026-05-01T00:00'),
        zoned('2026-08-01T00:00'),
      );

      // Second-to-last workday: May 28 (Thu), Jun 29 (Mon), Jul 30 (Thu).
      expect(
        result.map((occ) => localDate(occ.occurrenceStart, anchor.timezone)),
      ).toEqual(['2026-05-28', '2026-06-29', '2026-07-30']);
    });

    it('keeps last-working-day correct across a month-boundary weekend run', () => {
      // Oct 2026: 31st Sat, 30th Fri → last workday Fri Oct 30; day-before Thu 29.
      const anchor = makeTask({ startAt: zoned('2026-10-29T09:00') });
      const rule = makeRule({
        frequency: RecurrenceFrequency.MONTHLY,
        monthlyAnchor: MonthlyAnchorMode.DAY_BEFORE_LAST_WORKDAY,
      });

      const result = service.expandOccurrences(
        anchor,
        rule,
        [],
        zoned('2026-10-01T00:00'),
        zoned('2026-12-01T00:00'),
      );

      // Oct day-before-last-workday = Thu 29; Nov last workday Mon 30 → day-before Fri 27.
      expect(
        result.map((occ) => localDate(occ.occurrenceStart, anchor.timezone)),
      ).toEqual(['2026-10-29', '2026-11-27']);
    });

    it('preserves wall-clock time across a spring-forward DST month', () => {
      // US DST springs forward 2026-03-08. A LAST_WORKDAY March rule must keep
      // the 09:00 local wall time regardless of the transition.
      const anchor = makeTask({ startAt: zoned('2026-02-27T09:00') }); // last workday Feb
      const rule = makeRule({
        frequency: RecurrenceFrequency.MONTHLY,
        monthlyAnchor: MonthlyAnchorMode.LAST_WORKDAY,
      });

      const result = service.expandOccurrences(
        anchor,
        rule,
        [],
        zoned('2026-02-01T00:00'),
        zoned('2026-05-01T00:00'),
      );

      // Feb 27 (Fri), Mar 31 (Tue), Apr 30 (Thu) — all at 09:00 local.
      expect(
        result.map((occ) => localDate(occ.occurrenceStart, anchor.timezone)),
      ).toEqual(['2026-02-27', '2026-03-31', '2026-04-30']);
      expect(
        result.map((occ) => localHour(occ.occurrenceStart, anchor.timezone)),
      ).toEqual([9, 9, 9]);
    });
  });

  describe('exceptions', () => {
    it('drops a skipped occurrence', () => {
      const anchor = makeTask({ startAt: zoned('2026-06-01T09:00') });
      const rule = makeRule({ frequency: RecurrenceFrequency.DAILY });
      const skipped = makeException(zoned('2026-06-02T09:00'), {
        isSkipped: true,
      });

      const result = service.expandOccurrences(
        anchor,
        rule,
        [skipped],
        zoned('2026-06-01T00:00'),
        zoned('2026-06-04T00:00'),
      );

      expect(
        result.map((occ) => localDate(occ.occurrenceStart, anchor.timezone)),
      ).toEqual(['2026-06-01', '2026-06-03']);
    });

    it('applies start/end/title overrides without moving originalStart', () => {
      const anchor = makeTask({
        startAt: zoned('2026-06-01T09:00'),
        endAt: zoned('2026-06-01T10:00'),
        title: 'Standup',
      });
      const rule = makeRule({ frequency: RecurrenceFrequency.DAILY });
      const movedStart = zoned('2026-06-02T14:00');
      const movedEnd = zoned('2026-06-02T15:30');
      const override = makeException(zoned('2026-06-02T09:00'), {
        overrideStartAt: movedStart,
        overrideEndAt: movedEnd,
        overrideTitle: 'Standup (moved)',
      });

      const result = service.expandOccurrences(
        anchor,
        rule,
        [override],
        zoned('2026-06-01T00:00'),
        zoned('2026-06-03T00:00'),
      );

      const overridden = result.find(
        (occ) =>
          occ.originalStart?.getTime() === zoned('2026-06-02T09:00').getTime(),
      ) as Occurrence;

      expect(overridden.isException).toBe(true);
      expect(overridden.occurrenceStart).toEqual(movedStart);
      expect(overridden.occurrenceEnd).toEqual(movedEnd);
      expect(overridden.title).toBe('Standup (moved)');
      // originalStart is the stable id and is NOT affected by the override.
      expect(overridden.originalStart).toEqual(zoned('2026-06-02T09:00'));

      // A non-overridden sibling keeps the anchor title and computed end.
      const plain = result.find(
        (occ) =>
          occ.originalStart?.getTime() === zoned('2026-06-01T09:00').getTime(),
      ) as Occurrence;

      expect(plain.title).toBe('Standup');
      expect(plain.occurrenceEnd).toEqual(zoned('2026-06-01T10:00'));
    });

    it('carries per-instance completedAt from the exception', () => {
      const anchor = makeTask({ startAt: zoned('2026-06-01T09:00') });
      const rule = makeRule({ frequency: RecurrenceFrequency.DAILY });
      const completedAt = zoned('2026-06-02T09:30');
      const completion = makeException(zoned('2026-06-02T09:00'), {
        completedAt,
      });

      const result = service.expandOccurrences(
        anchor,
        rule,
        [completion],
        zoned('2026-06-01T00:00'),
        zoned('2026-06-04T00:00'),
      );

      const completed = result.find(
        (occ) =>
          occ.originalStart?.getTime() === zoned('2026-06-02T09:00').getTime(),
      ) as Occurrence;
      const other = result.find(
        (occ) =>
          occ.originalStart?.getTime() === zoned('2026-06-01T09:00').getTime(),
      ) as Occurrence;

      expect(completed.completedAt).toEqual(completedAt);
      expect(other.completedAt).toBeNull();
    });
  });

  describe('recurrence summary', () => {
    it('attaches a TASK-source summary carrying the effective rule by default', () => {
      const anchor = makeTask({ startAt: zoned('2026-06-01T09:00') });
      const rule = makeRule({ frequency: RecurrenceFrequency.WEEKLY });

      const [first] = service.expandOccurrences(
        anchor,
        rule,
        [],
        zoned('2026-06-01T00:00'),
        zoned('2026-06-08T00:00'),
      );

      expect(first.recurrence).not.toBeNull();
      expect(first.recurrence?.source).toBe(RecurrenceSource.TASK);
      expect(first.recurrence?.groupName).toBeNull();
      // The summary carries the SAME effective config the engine expanded.
      expect(first.recurrence?.config).toBe(rule);
    });

    it('attaches a GROUP-source summary with the group name when source is GROUP', () => {
      const anchor = makeTask({
        startAt: zoned('2026-06-01T09:00'),
        // The inherited path loads the group relation; the engine reads its name.
        group: { name: 'Work', recurrenceConfig: null } as never,
      });
      const rule = makeRule({ frequency: RecurrenceFrequency.DAILY });

      const [first] = service.expandOccurrences(
        anchor,
        rule,
        [],
        zoned('2026-06-01T00:00'),
        zoned('2026-06-03T00:00'),
        RecurrenceSource.GROUP,
      );

      expect(first.recurrence?.source).toBe(RecurrenceSource.GROUP);
      expect(first.recurrence?.groupName).toBe('Work');
    });
  });

  describe('duration', () => {
    it('derives occurrenceEnd from the anchor duration for timed events', () => {
      const anchor = makeTask({
        startAt: zoned('2026-06-01T09:00'),
        endAt: zoned('2026-06-01T09:45'),
      });
      const rule = makeRule({ frequency: RecurrenceFrequency.DAILY });

      const result = service.expandOccurrences(
        anchor,
        rule,
        [],
        zoned('2026-06-01T00:00'),
        zoned('2026-06-03T00:00'),
      );

      result.forEach((occ) => {
        const durationMillis =
          (occ.occurrenceEnd as Date).getTime() -
          (occ.occurrenceStart as Date).getTime();

        expect(durationMillis).toBe(45 * 60 * 1000);
      });
    });

    it('leaves occurrenceEnd null when the anchor has no endAt', () => {
      const anchor = makeTask({
        startAt: zoned('2026-06-01T09:00'),
        endAt: null,
      });
      const rule = makeRule({ frequency: RecurrenceFrequency.DAILY });

      const result = service.expandOccurrences(
        anchor,
        rule,
        [],
        zoned('2026-06-01T00:00'),
        zoned('2026-06-03T00:00'),
      );

      expect(result.every((occ) => occ.occurrenceEnd === null)).toBe(true);
    });
  });

  describe('all-day occurrences', () => {
    it('steps an all-day daily series on the date axis across DST (midnight preserved)', () => {
      const zone = 'America/New_York';
      const anchor = makeTask({
        timezone: zone,
        isAllDay: true,
        startAt: zoned('2026-03-07T00:00', zone),
        endAt: zoned('2026-03-08T00:00', zone),
      });
      const rule = makeRule({ frequency: RecurrenceFrequency.DAILY });

      const result = service.expandOccurrences(
        anchor,
        rule,
        [],
        zoned('2026-03-07T00:00', zone),
        zoned('2026-03-11T00:00', zone),
      );

      const dateToHour = result.map((occ) => [
        localDate(occ.occurrenceStart, zone),
        localHour(occ.occurrenceStart, zone),
      ]);

      expect(dateToHour).toEqual([
        ['2026-03-07', 0],
        ['2026-03-08', 0], // spring-forward day — still local midnight
        ['2026-03-09', 0],
        ['2026-03-10', 0],
      ]);
    });
  });

  describe('window intersection', () => {
    it('includes an occurrence that starts before the window but spans into it', () => {
      const anchor = makeTask({
        startAt: zoned('2026-06-01T23:00'),
        endAt: zoned('2026-06-02T01:00'), // 2h event crossing midnight
      });
      const rule = makeRule({ frequency: RecurrenceFrequency.DAILY });

      const result = service.expandOccurrences(
        anchor,
        rule,
        [],
        zoned('2026-06-02T00:00'), // window opens mid-event
        zoned('2026-06-03T00:00'),
      );

      // The 2026-06-01T23:00 instance ends at 2026-06-02T01:00, intersecting the window.
      expect(
        result.some(
          (occ) =>
            occ.originalStart?.getTime() ===
            zoned('2026-06-01T23:00').getTime(),
        ),
      ).toBe(true);
    });
  });

  describe('safety cap', () => {
    it('truncates at MAX_OCCURRENCES_PER_WINDOW and warns', () => {
      const warnSpy = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      const anchor = makeTask({ startAt: zoned('2020-01-01T09:00') });
      const rule = makeRule({ frequency: RecurrenceFrequency.DAILY });

      // ~10 years of daily occurrences far exceeds the 1000 cap.
      const result = service.expandOccurrences(
        anchor,
        rule,
        [],
        zoned('2020-01-01T00:00'),
        zoned('2030-01-01T00:00'),
      );

      expect(result).toHaveLength(1000);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain('truncated');
    });

    it('warns when the generation-step backstop is hit before reaching the window (Fix 4)', () => {
      const warnSpy = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      // A daily anchor ~330 years before the window exhausts MAX_GENERATION_STEPS
      // (1000 * 64) long before the cursor reaches 2030 — previously a silent
      // empty result with no log.
      const anchor = makeTask({ startAt: zoned('1700-01-01T09:00') });
      const rule = makeRule({ frequency: RecurrenceFrequency.DAILY });

      const result = service.expandOccurrences(
        anchor,
        rule,
        [],
        zoned('2030-01-01T00:00'),
        zoned('2030-01-02T00:00'),
      );

      // The window was never reached, so nothing is returned — but it is logged.
      expect(result).toHaveLength(0);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain('backstop');
    });
  });

  describe('one-off / degenerate anchors', () => {
    it('returns nothing when the anchor has no startAt', () => {
      const anchor = makeTask({ startAt: null });
      const rule = makeRule({ frequency: RecurrenceFrequency.DAILY });

      const result = service.expandOccurrences(
        anchor,
        rule,
        [],
        zoned('2026-06-01T00:00'),
        zoned('2026-06-30T00:00'),
      );

      expect(result).toEqual([]);
    });
  });
});

describe('RecurrenceRuleService.previewSeriesOccurrences (Story 9)', () => {
  let service: RecurrenceRuleService;

  beforeEach(() => {
    // Pure + I/O-free: no DB dependency when previewing a series (ADR 0054).
    service = new RecurrenceRuleService();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('expands a bounded COUNT series from the proposed anchor', () => {
    const result = service.previewSeriesOccurrences({
      title: 'Standup',
      startAt: zoned('2026-06-01T09:00'),
      endAt: zoned('2026-06-01T09:30'),
      timezone: 'America/New_York',
      recurrence: {
        frequency: RecurrenceFrequency.WEEKLY,
        endType: RecurrenceEndType.COUNT,
        count: 3,
      },
    });

    expect(
      result.map((occ) => localDate(occ.occurrenceStart, 'America/New_York')),
    ).toEqual(['2026-06-01', '2026-06-08', '2026-06-15']);
    expect(result.every((occ) => occ.isRecurring)).toBe(true);
  });

  it('bounds a NEVER-ending rule to the look-ahead horizon (never unbounded)', () => {
    const result = service.previewSeriesOccurrences({
      title: 'Daily',
      startAt: zoned('2026-06-01T09:00'),
      endAt: zoned('2026-06-01T09:30'),
      timezone: 'America/New_York',
      recurrence: { frequency: RecurrenceFrequency.DAILY },
    });

    // ~2 years of daily occurrences — finite, capped well under the engine's
    // MAX_OCCURRENCES_PER_WINDOW, and the scan returns rather than hanging.
    expect(result.length).toBeGreaterThan(700);
    expect(result.length).toBeLessThan(740);
  });
});

describe('RecurrenceRuleService.toConfig', () => {
  it('normalizes a validated DTO into a fully-populated inline config', () => {
    const config = RecurrenceRuleService.toConfig({
      frequency: RecurrenceFrequency.WEEKLY,
      byWeekday: [0, 2, 4],
      endType: RecurrenceEndType.COUNT,
      count: 10,
    });

    expect(config).toEqual({
      frequency: RecurrenceFrequency.WEEKLY,
      interval: 1, // defaulted
      byWeekday: [0, 2, 4],
      byMonthDay: null,
      byMonth: null,
      bySetPos: null,
      monthlyAnchor: null,
      endType: RecurrenceEndType.COUNT,
      endDate: null,
      count: 10,
    });
  });

  it('defaults endType to NEVER and the by* / end fields to null', () => {
    const config = RecurrenceRuleService.toConfig({
      frequency: RecurrenceFrequency.DAILY,
    });

    expect(config).toEqual({
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
  });

  it('carries bySetPos + monthlyAnchor through to the inline config', () => {
    const nthWeekday = RecurrenceRuleService.toConfig({
      frequency: RecurrenceFrequency.MONTHLY,
      byWeekday: [0],
      bySetPos: [-1],
    });
    const workday = RecurrenceRuleService.toConfig({
      frequency: RecurrenceFrequency.MONTHLY,
      monthlyAnchor: MonthlyAnchorMode.FIRST_WORKDAY,
    });

    expect(nthWeekday.bySetPos).toEqual([-1]);
    expect(nthWeekday.monthlyAnchor).toBeNull();
    expect(workday.monthlyAnchor).toBe(MonthlyAnchorMode.FIRST_WORKDAY);
    expect(workday.bySetPos).toBeNull();
  });

  it('produces a config the engine can expand directly', () => {
    const service = new RecurrenceRuleService();
    const anchor = makeTask({ startAt: zoned('2026-06-01T09:00') });
    const config = RecurrenceRuleService.toConfig({
      frequency: RecurrenceFrequency.DAILY,
      endType: RecurrenceEndType.COUNT,
      count: 2,
    });

    const result = service.expandOccurrences(
      anchor,
      config,
      [],
      zoned('2026-06-01T00:00'),
      zoned('2026-06-10T00:00'),
    );

    expect(
      result.map((occ) => localDate(occ.occurrenceStart, anchor.timezone)),
    ).toEqual(['2026-06-01', '2026-06-02']);
  });
});
