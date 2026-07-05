import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

import { Logger } from '@nestjs/common';
import { DateTime } from 'luxon';

import { RecurrenceRuleService } from './recurrence-rule.service';
import {
  MonthlyAnchorMode,
  Occurrence,
  RecurrenceConfig,
} from './recurrence.types';
import {
  RecurrenceEndType,
  RecurrenceFrequency,
  Task,
  TaskOccurrenceException,
} from '@/modules/database/entities';

/**
 * Golden parity-fixture generator (full-calendar-replica-sync spec §3.6).
 *
 * This spec runs the REAL {@link RecurrenceRuleService.expandOccurrences} — the
 * single server-side source of truth for recurrence — over a curated matrix of
 * rules, timezones (incl. both DST transitions), end conditions, and exceptions,
 * and serializes each case's exact output to `docs/fixtures/recurrence-parity.json`.
 *
 * The iOS Swift engine replays the SAME file and must reproduce every instant to
 * epoch-ms exactness. Regenerate with `GENERATE_FIXTURES=1 pnpm jest
 * recurrence-parity-fixtures`; any BE engine change that alters output makes this
 * spec fail until the fixtures (and therefore the iOS parity suite) are refreshed
 * in the same change — that failure is the intended alarm, not a nuisance.
 *
 * Scope: `expandOccurrences` only (expansion + exception application). Override
 * suppression / one-off-wrap / group-merge live in `findOccurrencesInRange`
 * (a higher layer) and get their own projection-parity corpus in Phase 3.
 */

const FIXTURE_PATH = join(
  process.cwd(),
  'docs',
  'fixtures',
  'recurrence-parity.json',
);

// Representative zones: US + EU DST (both transitions), a UTC control, and a
// half-hour no-DST offset (India) to catch offset-arithmetic assumptions.
const NEW_YORK = 'America/New_York';
const KYIV = 'Europe/Kyiv';
const BERLIN = 'Europe/Berlin';
const UTC = 'UTC';
const KOLKATA = 'Asia/Kolkata';

/** Wall-clock ISO (in the given zone) → the UTC instant a column would hold. */
const at = (wall: string, zone: string): Date =>
  DateTime.fromISO(wall, { zone }).toJSDate();

/** UTC instant → canonical fractional-second ISO string (or null). */
const iso = (date: Date | null): string | null =>
  date ? date.toISOString() : null;

interface FixtureTask {
  id: string;
  title: string;
  timezone: string;
  startAt: string | null;
  endAt: string | null;
  isAllDay: boolean;
}

interface FixtureException {
  originalStartAt: string;
  isSkipped: boolean;
  overrideStartAt: string | null;
  overrideEndAt: string | null;
  overrideTitle: string | null;
  completedAt: string | null;
}

interface FixtureExpected {
  originalStart: string | null;
  occurrenceStart: string | null;
  occurrenceEnd: string | null;
  title: string;
  completedAt: string | null;
  isException: boolean;
}

interface Fixture {
  name: string;
  task: FixtureTask;
  config: RecurrenceConfig;
  exceptions: FixtureException[];
  window: { from: string; to: string };
  expected: FixtureExpected[];
}

interface ExceptionInput {
  /** Wall-clock (in the task zone) of the rule-generated slot this exception keys. */
  originalStart: string;
  isSkipped?: boolean;
  overrideStart?: string | null;
  overrideEnd?: string | null;
  overrideTitle?: string | null;
  completedAt?: string | null;
}

interface CaseInput {
  name: string;
  zone: string;
  /** Wall-clock start in `zone`. */
  start: string;
  /** Wall-clock end in `zone`, or null for an open-ended / todo-like anchor. */
  end?: string | null;
  isAllDay?: boolean;
  title?: string;
  config: Partial<RecurrenceConfig> & { frequency: RecurrenceFrequency };
  exceptions?: ExceptionInput[];
  /** Window bounds as wall-clock in `zone` (default), or `[iso, 'UTC']` tuples. */
  window: { from: string; to: string; zone?: string };
}

const fullConfig = (
  partial: Partial<RecurrenceConfig> & { frequency: RecurrenceFrequency },
): RecurrenceConfig => ({
  frequency: partial.frequency,
  interval: partial.interval ?? 1,
  byWeekday: partial.byWeekday ?? null,
  byMonthDay: partial.byMonthDay ?? null,
  byMonth: partial.byMonth ?? null,
  bySetPos: partial.bySetPos ?? null,
  monthlyAnchor: partial.monthlyAnchor ?? null,
  endType: partial.endType ?? RecurrenceEndType.NEVER,
  endDate: partial.endDate ?? null,
  count: partial.count ?? null,
});

/**
 * Runs one case through the real engine and captures its output as a fixture.
 */
const buildFixture = (
  service: RecurrenceRuleService,
  input: CaseInput,
): Fixture => {
  const zone = input.zone;
  const config = fullConfig(input.config);

  const anchor = {
    id: 'anchor',
    title: input.title ?? 'Anchor',
    timezone: zone,
    startAt: at(input.start, zone),
    endAt: input.end === undefined ? null : input.end === null ? null : at(input.end, zone),
    isAllDay: input.isAllDay ?? false,
    parentTaskId: null,
    detachedAt: null,
    completedAt: null,
  } as Task;

  const exceptions: TaskOccurrenceException[] = (input.exceptions ?? []).map(
    (exc) =>
      ({
        id: `exc-${exc.originalStart}`,
        taskId: 'anchor',
        originalStartAt: at(exc.originalStart, zone),
        isSkipped: exc.isSkipped ?? false,
        overrideStartAt:
          exc.overrideStart != null ? at(exc.overrideStart, zone) : null,
        overrideEndAt: exc.overrideEnd != null ? at(exc.overrideEnd, zone) : null,
        overrideTitle: exc.overrideTitle ?? null,
        completedAt: exc.completedAt != null ? at(exc.completedAt, zone) : null,
      }) as TaskOccurrenceException,
  );

  const windowZone = input.window.zone ?? zone;
  const windowFrom = at(input.window.from, windowZone);
  const windowTo = at(input.window.to, windowZone);

  const occurrences: Occurrence[] = service.expandOccurrences(
    anchor,
    config,
    exceptions,
    windowFrom,
    windowTo,
  );

  return {
    name: input.name,
    task: {
      id: anchor.id,
      title: anchor.title,
      timezone: zone,
      startAt: iso(anchor.startAt),
      endAt: iso(anchor.endAt),
      isAllDay: anchor.isAllDay,
    },
    config,
    exceptions: exceptions.map((exc) => ({
      originalStartAt: iso(exc.originalStartAt) as string,
      isSkipped: exc.isSkipped,
      overrideStartAt: iso(exc.overrideStartAt),
      overrideEndAt: iso(exc.overrideEndAt),
      overrideTitle: exc.overrideTitle,
      completedAt: iso(exc.completedAt),
    })),
    window: { from: iso(windowFrom) as string, to: iso(windowTo) as string },
    expected: occurrences.map((occ) => ({
      originalStart: iso(occ.originalStart),
      occurrenceStart: iso(occ.occurrenceStart),
      occurrenceEnd: iso(occ.occurrenceEnd),
      title: occ.title,
      completedAt: iso(occ.completedAt),
      isException: occ.isException,
    })),
  };
};

// ---------------------------------------------------------------------------
// The case matrix. Wall-clock inputs in each case's `zone`; the engine computes
// every `expected` value, so nothing here is hand-derived.
// ---------------------------------------------------------------------------

const cases: CaseInput[] = [
  // --- Frequencies × intervals ---------------------------------------------
  {
    name: 'daily-interval-1',
    zone: NEW_YORK,
    start: '2026-06-01T09:00',
    end: '2026-06-01T10:00',
    config: { frequency: RecurrenceFrequency.DAILY },
    window: { from: '2026-06-01T00:00', to: '2026-06-06T00:00' },
  },
  {
    name: 'daily-interval-2',
    zone: NEW_YORK,
    start: '2026-06-01T09:00',
    end: '2026-06-01T09:30',
    config: { frequency: RecurrenceFrequency.DAILY, interval: 2 },
    window: { from: '2026-06-01T00:00', to: '2026-06-11T00:00' },
  },
  {
    name: 'daily-interval-5',
    zone: NEW_YORK,
    start: '2026-06-01T09:00',
    end: '2026-06-01T09:30',
    config: { frequency: RecurrenceFrequency.DAILY, interval: 5 },
    window: { from: '2026-06-01T00:00', to: '2026-07-01T00:00' },
  },
  {
    name: 'weekly-no-byweekday',
    zone: NEW_YORK,
    start: '2026-06-03T09:00', // Wednesday
    end: '2026-06-03T10:00',
    config: { frequency: RecurrenceFrequency.WEEKLY },
    window: { from: '2026-06-01T00:00', to: '2026-07-01T00:00' },
  },
  {
    name: 'weekly-mon-wed-fri',
    zone: NEW_YORK,
    start: '2026-06-01T09:00', // Monday
    end: '2026-06-01T10:00',
    config: { frequency: RecurrenceFrequency.WEEKLY, byWeekday: [0, 2, 4] },
    window: { from: '2026-06-01T00:00', to: '2026-06-22T00:00' },
  },
  {
    name: 'weekly-interval-2-monday',
    zone: NEW_YORK,
    start: '2026-06-01T09:00', // Monday
    end: '2026-06-01T10:00',
    config: { frequency: RecurrenceFrequency.WEEKLY, interval: 2, byWeekday: [0] },
    window: { from: '2026-06-01T00:00', to: '2026-07-15T00:00' },
  },
  {
    name: 'weekly-sunday-boundary',
    zone: NEW_YORK,
    start: '2026-06-07T09:00', // Sunday — verifies Monday-anchored week expansion
    end: '2026-06-07T10:00',
    config: { frequency: RecurrenceFrequency.WEEKLY, byWeekday: [6] },
    window: { from: '2026-06-01T00:00', to: '2026-06-29T00:00' },
  },
  {
    name: 'weekly-all-seven-days',
    zone: NEW_YORK,
    start: '2026-06-01T08:00', // Monday
    end: '2026-06-01T08:30',
    config: {
      frequency: RecurrenceFrequency.WEEKLY,
      byWeekday: [0, 1, 2, 3, 4, 5, 6],
    },
    window: { from: '2026-06-01T00:00', to: '2026-06-15T00:00' },
  },

  // --- Monthly by-month-day (incl. overflow) --------------------------------
  {
    name: 'monthly-by-monthday-15',
    zone: NEW_YORK,
    start: '2026-01-15T09:00',
    end: '2026-01-15T10:00',
    config: { frequency: RecurrenceFrequency.MONTHLY, byMonthDay: [15] },
    window: { from: '2026-01-01T00:00', to: '2026-07-01T00:00' },
  },
  {
    name: 'monthly-by-monthday-31-overflow',
    zone: NEW_YORK,
    start: '2026-01-31T09:00',
    end: '2026-01-31T10:00',
    config: { frequency: RecurrenceFrequency.MONTHLY, byMonthDay: [31] },
    window: { from: '2026-01-01T00:00', to: '2026-08-01T00:00' },
  },
  {
    name: 'monthly-by-monthday-30-overflow-feb',
    zone: NEW_YORK,
    start: '2026-01-30T09:00',
    end: '2026-01-30T10:00',
    config: { frequency: RecurrenceFrequency.MONTHLY, byMonthDay: [30] },
    window: { from: '2026-01-01T00:00', to: '2026-05-01T00:00' },
  },
  {
    name: 'monthly-by-monthday-29-nonleap-feb',
    zone: NEW_YORK,
    start: '2026-01-29T09:00',
    end: '2026-01-29T10:00',
    config: { frequency: RecurrenceFrequency.MONTHLY, byMonthDay: [29] },
    window: { from: '2026-01-01T00:00', to: '2026-05-01T00:00' },
  },
  {
    name: 'monthly-by-monthday-29-leap-feb-2028',
    zone: NEW_YORK,
    start: '2028-01-29T09:00',
    end: '2028-01-29T10:00',
    config: { frequency: RecurrenceFrequency.MONTHLY, byMonthDay: [29] },
    window: { from: '2028-01-01T00:00', to: '2028-05-01T00:00' },
  },
  {
    name: 'monthly-fallback-seedday-31',
    zone: NEW_YORK,
    start: '2026-01-31T09:00',
    end: '2026-01-31T10:00',
    config: { frequency: RecurrenceFrequency.MONTHLY },
    window: { from: '2026-01-01T00:00', to: '2026-08-01T00:00' },
  },
  {
    name: 'monthly-interval-2-day-1',
    zone: NEW_YORK,
    start: '2026-01-01T09:00',
    end: '2026-01-01T10:00',
    config: { frequency: RecurrenceFrequency.MONTHLY, interval: 2, byMonthDay: [1] },
    window: { from: '2026-01-01T00:00', to: '2026-12-01T00:00' },
  },
  {
    name: 'monthly-multi-monthday',
    zone: NEW_YORK,
    start: '2026-01-01T09:00',
    end: '2026-01-01T10:00',
    config: { frequency: RecurrenceFrequency.MONTHLY, byMonthDay: [1, 15, 31] },
    window: { from: '2026-01-01T00:00', to: '2026-04-01T00:00' },
  },

  // --- Monthly bySetPos (nth weekday) --------------------------------------
  {
    name: 'monthly-first-monday',
    zone: NEW_YORK,
    start: '2026-01-05T09:00', // first Monday of Jan 2026
    end: '2026-01-05T10:00',
    config: { frequency: RecurrenceFrequency.MONTHLY, byWeekday: [0], bySetPos: [1] },
    window: { from: '2026-01-01T00:00', to: '2026-07-01T00:00' },
  },
  {
    name: 'monthly-second-tuesday',
    zone: NEW_YORK,
    start: '2026-01-13T09:00',
    end: '2026-01-13T10:00',
    config: { frequency: RecurrenceFrequency.MONTHLY, byWeekday: [1], bySetPos: [2] },
    window: { from: '2026-01-01T00:00', to: '2026-07-01T00:00' },
  },
  {
    name: 'monthly-last-friday',
    zone: NEW_YORK,
    start: '2026-01-30T09:00',
    end: '2026-01-30T10:00',
    config: { frequency: RecurrenceFrequency.MONTHLY, byWeekday: [4], bySetPos: [-1] },
    window: { from: '2026-01-01T00:00', to: '2026-07-01T00:00' },
  },
  {
    name: 'monthly-first-and-last-monday',
    zone: NEW_YORK,
    start: '2026-01-05T09:00',
    end: '2026-01-05T10:00',
    config: {
      frequency: RecurrenceFrequency.MONTHLY,
      byWeekday: [0],
      bySetPos: [1, -1],
    },
    window: { from: '2026-01-01T00:00', to: '2026-04-01T00:00' },
  },
  {
    name: 'monthly-fifth-monday-often-overflow',
    zone: NEW_YORK,
    start: '2026-03-30T09:00', // a month with a 5th Monday
    end: '2026-03-30T10:00',
    config: { frequency: RecurrenceFrequency.MONTHLY, byWeekday: [0], bySetPos: [5] },
    window: { from: '2026-01-01T00:00', to: '2026-12-31T00:00' },
  },

  // --- Monthly working-day anchors -----------------------------------------
  {
    name: 'monthly-first-workday',
    zone: NEW_YORK,
    start: '2026-01-01T09:00',
    end: '2026-01-01T10:00',
    config: {
      frequency: RecurrenceFrequency.MONTHLY,
      monthlyAnchor: MonthlyAnchorMode.FIRST_WORKDAY,
    },
    window: { from: '2026-01-01T00:00', to: '2026-07-01T00:00' },
  },
  {
    name: 'monthly-last-workday',
    zone: NEW_YORK,
    start: '2026-01-30T09:00',
    end: '2026-01-30T10:00',
    config: {
      frequency: RecurrenceFrequency.MONTHLY,
      monthlyAnchor: MonthlyAnchorMode.LAST_WORKDAY,
    },
    window: { from: '2026-01-01T00:00', to: '2026-07-01T00:00' },
  },
  {
    name: 'monthly-day-before-last-workday',
    zone: NEW_YORK,
    start: '2026-01-29T09:00',
    end: '2026-01-29T10:00',
    config: {
      frequency: RecurrenceFrequency.MONTHLY,
      monthlyAnchor: MonthlyAnchorMode.DAY_BEFORE_LAST_WORKDAY,
    },
    window: { from: '2026-01-01T00:00', to: '2026-07-01T00:00' },
  },

  // --- Yearly ---------------------------------------------------------------
  {
    name: 'yearly-seed-month-day',
    zone: NEW_YORK,
    start: '2026-03-15T09:00',
    end: '2026-03-15T10:00',
    config: { frequency: RecurrenceFrequency.YEARLY },
    window: { from: '2026-01-01T00:00', to: '2030-01-01T00:00' },
  },
  {
    name: 'yearly-bymonth-jan-jul-day15',
    zone: NEW_YORK,
    start: '2026-01-15T09:00',
    end: '2026-01-15T10:00',
    config: {
      frequency: RecurrenceFrequency.YEARLY,
      byMonth: [1, 7],
      byMonthDay: [15],
    },
    window: { from: '2026-01-01T00:00', to: '2029-01-01T00:00' },
  },
  {
    name: 'yearly-leap-feb-29',
    zone: NEW_YORK,
    start: '2024-02-29T09:00',
    end: '2024-02-29T10:00',
    config: {
      frequency: RecurrenceFrequency.YEARLY,
      byMonth: [2],
      byMonthDay: [29],
    },
    window: { from: '2024-01-01T00:00', to: '2033-01-01T00:00' },
  },

  // --- End conditions -------------------------------------------------------
  {
    name: 'until-date-inclusive-boundary',
    zone: NEW_YORK,
    start: '2026-06-01T09:00',
    end: '2026-06-01T10:00',
    config: {
      frequency: RecurrenceFrequency.DAILY,
      endType: RecurrenceEndType.UNTIL_DATE,
      endDate: '2026-06-05',
    },
    window: { from: '2026-06-01T00:00', to: '2026-06-30T00:00' },
  },
  {
    name: 'until-date-midseries',
    zone: NEW_YORK,
    start: '2026-06-01T09:00',
    end: '2026-06-01T10:00',
    config: {
      frequency: RecurrenceFrequency.WEEKLY,
      byWeekday: [0, 3],
      endType: RecurrenceEndType.UNTIL_DATE,
      endDate: '2026-06-18',
    },
    window: { from: '2026-06-01T00:00', to: '2026-08-01T00:00' },
  },
  {
    name: 'count-5-window-covers-all',
    zone: NEW_YORK,
    start: '2026-06-01T09:00',
    end: '2026-06-01T10:00',
    config: {
      frequency: RecurrenceFrequency.DAILY,
      endType: RecurrenceEndType.COUNT,
      count: 5,
    },
    window: { from: '2026-06-01T00:00', to: '2026-06-30T00:00' },
  },
  {
    name: 'count-5-window-starts-midseries',
    zone: NEW_YORK,
    start: '2026-06-01T09:00',
    end: '2026-06-01T10:00',
    config: {
      frequency: RecurrenceFrequency.DAILY,
      endType: RecurrenceEndType.COUNT,
      count: 5,
    },
    // window opens on day 3 — count still measured from origin, so only 3,4,5 show
    window: { from: '2026-06-03T00:00', to: '2026-06-30T00:00' },
  },
  {
    name: 'count-10-window-narrower',
    zone: NEW_YORK,
    start: '2026-06-01T09:00',
    end: '2026-06-01T10:00',
    config: {
      frequency: RecurrenceFrequency.DAILY,
      endType: RecurrenceEndType.COUNT,
      count: 10,
    },
    window: { from: '2026-06-01T00:00', to: '2026-06-05T00:00' },
  },

  // --- Timezones & DST ------------------------------------------------------
  {
    name: 'ny-spring-forward-0230',
    zone: NEW_YORK,
    start: '2026-03-06T02:30', // exists; steps across 2026-03-08 spring-forward
    end: '2026-03-06T03:00',
    config: { frequency: RecurrenceFrequency.DAILY },
    window: { from: '2026-03-06T00:00', to: '2026-03-11T00:00' },
  },
  {
    name: 'ny-fall-back-0130',
    zone: NEW_YORK,
    start: '2026-10-30T01:30',
    end: '2026-10-30T02:00',
    config: { frequency: RecurrenceFrequency.DAILY },
    window: { from: '2026-10-30T00:00', to: '2026-11-04T00:00' },
  },
  {
    name: 'kyiv-spring-forward-0330',
    zone: KYIV,
    start: '2026-03-27T03:30',
    end: '2026-03-27T04:00',
    config: { frequency: RecurrenceFrequency.DAILY },
    window: { from: '2026-03-27T00:00', to: '2026-04-01T00:00' },
  },
  {
    name: 'kyiv-fall-back-0330',
    zone: KYIV,
    start: '2026-10-23T03:30',
    end: '2026-10-23T04:00',
    config: { frequency: RecurrenceFrequency.DAILY },
    window: { from: '2026-10-23T00:00', to: '2026-10-28T00:00' },
  },
  {
    name: 'berlin-spring-forward-weekly',
    zone: BERLIN,
    start: '2026-03-22T02:30', // Sunday before EU spring-forward (2026-03-29)
    end: '2026-03-22T03:15',
    config: { frequency: RecurrenceFrequency.WEEKLY, byWeekday: [6] },
    window: { from: '2026-03-01T00:00', to: '2026-04-19T00:00' },
  },
  {
    name: 'berlin-fall-back-daily-0230',
    zone: BERLIN,
    start: '2026-10-23T02:30',
    end: '2026-10-23T03:00',
    config: { frequency: RecurrenceFrequency.DAILY },
    window: { from: '2026-10-23T00:00', to: '2026-10-28T00:00' },
  },
  {
    name: 'utc-daily-control',
    zone: UTC,
    start: '2026-03-06T02:30',
    end: '2026-03-06T03:00',
    config: { frequency: RecurrenceFrequency.DAILY },
    window: { from: '2026-03-06T00:00', to: '2026-03-11T00:00' },
  },
  {
    name: 'kolkata-halfhour-offset-daily',
    zone: KOLKATA,
    start: '2026-06-01T09:15',
    end: '2026-06-01T10:15',
    config: { frequency: RecurrenceFrequency.DAILY },
    window: { from: '2026-06-01T00:00', to: '2026-06-05T00:00' },
  },
  {
    name: 'ny-allday-across-spring-forward',
    zone: NEW_YORK,
    start: '2026-03-06T00:00',
    end: '2026-03-07T00:00',
    isAllDay: true,
    config: { frequency: RecurrenceFrequency.DAILY },
    window: { from: '2026-03-06T00:00', to: '2026-03-11T00:00' },
  },
  {
    name: 'berlin-allday-across-fall-back',
    zone: BERLIN,
    start: '2026-10-23T00:00',
    end: '2026-10-24T00:00',
    isAllDay: true,
    config: { frequency: RecurrenceFrequency.DAILY },
    window: { from: '2026-10-23T00:00', to: '2026-10-28T00:00' },
  },
  {
    name: 'monthly-across-dst-preserves-walltime',
    zone: NEW_YORK,
    start: '2026-01-15T09:00',
    end: '2026-01-15T10:00',
    config: { frequency: RecurrenceFrequency.MONTHLY, byMonthDay: [15] },
    // Jan (EST) → beyond March spring-forward (EDT); wall-clock 09:00 must hold
    window: { from: '2026-01-01T00:00', to: '2026-06-01T00:00' },
  },

  // --- Multi-day durations & todos -----------------------------------------
  {
    name: 'multiday-duration-crossing-window-edge',
    zone: NEW_YORK,
    start: '2026-06-01T20:00',
    end: '2026-06-03T04:00', // 32h span
    config: { frequency: RecurrenceFrequency.WEEKLY, byWeekday: [0] },
    window: { from: '2026-06-01T00:00', to: '2026-07-01T00:00' },
  },
  {
    name: 'open-ended-no-endat',
    zone: NEW_YORK,
    start: '2026-06-01T09:00',
    end: null,
    config: { frequency: RecurrenceFrequency.DAILY },
    window: { from: '2026-06-01T00:00', to: '2026-06-05T00:00' },
  },

  // --- Exceptions -----------------------------------------------------------
  {
    name: 'exception-skip-one',
    zone: NEW_YORK,
    start: '2026-06-01T09:00',
    end: '2026-06-01T10:00',
    config: { frequency: RecurrenceFrequency.DAILY },
    exceptions: [{ originalStart: '2026-06-03T09:00', isSkipped: true }],
    window: { from: '2026-06-01T00:00', to: '2026-06-06T00:00' },
  },
  {
    name: 'exception-move-same-day',
    zone: NEW_YORK,
    start: '2026-06-01T09:00',
    end: '2026-06-01T10:00',
    config: { frequency: RecurrenceFrequency.DAILY },
    exceptions: [
      { originalStart: '2026-06-03T09:00', overrideStart: '2026-06-03T14:00' },
    ],
    window: { from: '2026-06-01T00:00', to: '2026-06-06T00:00' },
  },
  {
    name: 'exception-move-cross-month',
    zone: NEW_YORK,
    start: '2026-06-15T09:00',
    end: '2026-06-15T10:00',
    config: { frequency: RecurrenceFrequency.MONTHLY, byMonthDay: [15] },
    exceptions: [
      { originalStart: '2026-07-15T09:00', overrideStart: '2026-08-02T11:00' },
    ],
    window: { from: '2026-06-01T00:00', to: '2026-09-01T00:00' },
  },
  {
    name: 'exception-resize',
    zone: NEW_YORK,
    start: '2026-06-01T09:00',
    end: '2026-06-01T10:00',
    config: { frequency: RecurrenceFrequency.DAILY },
    exceptions: [
      { originalStart: '2026-06-02T09:00', overrideEnd: '2026-06-02T12:30' },
    ],
    window: { from: '2026-06-01T00:00', to: '2026-06-06T00:00' },
  },
  {
    name: 'exception-retitle',
    zone: NEW_YORK,
    start: '2026-06-01T09:00',
    end: '2026-06-01T10:00',
    config: { frequency: RecurrenceFrequency.DAILY },
    exceptions: [{ originalStart: '2026-06-04T09:00', overrideTitle: 'Special day' }],
    window: { from: '2026-06-01T00:00', to: '2026-06-06T00:00' },
  },
  {
    name: 'exception-complete',
    zone: NEW_YORK,
    start: '2026-06-01T09:00',
    end: '2026-06-01T10:00',
    config: { frequency: RecurrenceFrequency.DAILY },
    exceptions: [
      { originalStart: '2026-06-02T09:00', completedAt: '2026-06-02T09:45' },
    ],
    window: { from: '2026-06-01T00:00', to: '2026-06-06T00:00' },
  },
  {
    name: 'exception-move-resize-retitle-complete',
    zone: NEW_YORK,
    start: '2026-06-01T09:00',
    end: '2026-06-01T10:00',
    config: { frequency: RecurrenceFrequency.DAILY },
    exceptions: [
      {
        originalStart: '2026-06-03T09:00',
        overrideStart: '2026-06-03T15:00',
        overrideEnd: '2026-06-03T17:30',
        overrideTitle: 'Reworked',
        completedAt: '2026-06-03T17:00',
      },
    ],
    window: { from: '2026-06-01T00:00', to: '2026-06-06T00:00' },
  },
  {
    name: 'exception-on-out-of-window-slot',
    zone: NEW_YORK,
    start: '2026-06-01T09:00',
    end: '2026-06-01T10:00',
    config: { frequency: RecurrenceFrequency.DAILY },
    exceptions: [{ originalStart: '2026-06-20T09:00', isSkipped: true }],
    window: { from: '2026-06-01T00:00', to: '2026-06-06T00:00' },
  },

  // --- Window edge semantics (half-open [from, to)) -------------------------
  {
    name: 'window-half-open-excludes-to',
    zone: NEW_YORK,
    start: '2026-06-01T00:00',
    end: '2026-06-01T01:00',
    config: { frequency: RecurrenceFrequency.DAILY },
    // occurrence exactly at `to` must be excluded; one exactly at `from` included
    window: { from: '2026-06-02T00:00', to: '2026-06-05T00:00' },
  },
  {
    name: 'occurrence-ending-exactly-at-from-excluded',
    zone: NEW_YORK,
    start: '2026-06-01T23:00',
    end: '2026-06-02T00:00', // ends exactly at window.from
    config: { frequency: RecurrenceFrequency.DAILY },
    window: { from: '2026-06-02T00:00', to: '2026-06-05T00:00' },
  },

  // --- Cap / backstop -------------------------------------------------------
  {
    name: 'cap-truncation-1000',
    zone: UTC,
    start: '2020-01-01T09:00',
    end: '2020-01-01T09:30',
    config: { frequency: RecurrenceFrequency.DAILY },
    // ~10 years daily → far exceeds MAX_OCCURRENCES_PER_WINDOW (1000)
    window: { from: '2020-01-01T00:00', to: '2030-01-01T00:00' },
  },
  {
    name: 'generation-backstop-farpast-anchor',
    zone: UTC,
    start: '1800-01-01T09:00',
    end: '1800-01-01T09:30',
    config: { frequency: RecurrenceFrequency.DAILY },
    // window > 64000 daily steps ahead of anchor → step backstop, empty result
    window: { from: '2030-01-01T00:00', to: '2030-02-01T00:00' },
  },
];

/**
 * Loads the optional adversarial case set (produced by the P0.4 divergence-audit
 * workflow) and appends it to the curated matrix, so hunted luxon-vs-Foundation
 * edge cases become permanent parity fixtures. Absent file ⇒ no extra cases.
 */
const loadAdversarialCases = (): CaseInput[] => {
  const path = join(
    process.cwd(),
    'docs',
    'fixtures',
    'adversarial-cases.json',
  );

  if (!existsSync(path)) return [];

  return JSON.parse(readFileSync(path, 'utf8')) as CaseInput[];
};

const allCases: CaseInput[] = [...cases, ...loadAdversarialCases()];

describe('recurrence parity fixtures', () => {
  let service: RecurrenceRuleService;

  beforeEach(() => {
    service = new RecurrenceRuleService();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('every case has a unique name', () => {
    const names = new Set(allCases.map((entry) => entry.name));

    expect(names.size).toBe(allCases.length);
  });

  it('matches the committed fixture corpus (regenerate with GENERATE_FIXTURES=1)', () => {
    const fixtures = allCases.map((entry) => buildFixture(service, entry));
    const serialized = `${JSON.stringify(fixtures, null, 2)}\n`;

    if (process.env.GENERATE_FIXTURES === '1') {
      mkdirSync(dirname(FIXTURE_PATH), { recursive: true });
      writeFileSync(FIXTURE_PATH, serialized);
    }

    expect(existsSync(FIXTURE_PATH)).toBe(true);

    const committed = readFileSync(FIXTURE_PATH, 'utf8');

    expect(serialized).toBe(committed);
  });

  it('cap-truncation case yields exactly MAX_OCCURRENCES_PER_WINDOW', () => {
    const fixture = buildFixture(
      service,
      cases.find((entry) => entry.name === 'cap-truncation-1000') as CaseInput,
    );

    expect(fixture.expected.length).toBe(1000);
  });

  it('far-past anchor beyond the step budget yields no occurrences', () => {
    const fixture = buildFixture(
      service,
      cases.find(
        (entry) => entry.name === 'generation-backstop-farpast-anchor',
      ) as CaseInput,
    );

    expect(fixture.expected.length).toBe(0);
  });
});
