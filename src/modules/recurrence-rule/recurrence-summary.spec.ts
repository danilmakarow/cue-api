import {
  formatRecurrenceSummary,
  summarizeRecurrenceConfig,
} from './recurrence-summary';
import {
  RecurrenceConfig,
  RecurrenceSource,
  RecurrenceSummary,
} from './recurrence.types';
import {
  RecurrenceEndType,
  RecurrenceFrequency,
} from '@/modules/database/entities';

/**
 * Builds a {@link RecurrenceConfig} with sensible no-selector / never-ending
 * defaults, overlaid with the given fields so each test states only the cadence
 * facet it exercises.
 */
const config = (over: Partial<RecurrenceConfig> = {}): RecurrenceConfig => ({
  frequency: RecurrenceFrequency.WEEKLY,
  interval: 1,
  byWeekday: null,
  byMonthDay: null,
  byMonth: null,
  endType: RecurrenceEndType.NEVER,
  endDate: null,
  count: null,
  ...over,
});

/** Wraps a config in a {@link RecurrenceSummary} with the given source/group. */
const summary = (
  configOver: Partial<RecurrenceConfig>,
  source: RecurrenceSource = RecurrenceSource.TASK,
  groupName: string | null = null,
): RecurrenceSummary => ({
  config: config(configOver),
  source,
  groupName,
});

/**
 * Unit coverage for the pure recurrence-summary renderer (the recurrence-context
 * fix): proves the cadence + end + source/edited markers render byte-for-byte the
 * way the assistant formatter appends them, so a reader (model + user) sees the
 * rule, its end, its source, and a per-instance override inline rather than as a
 * one-off. Pure + tz-free — a rule is a rule, not an instant.
 */
describe('summarizeRecurrenceConfig — cadence', () => {
  it('renders weekly with explicit weekdays (interval 1) as "every <days>"', () => {
    // byWeekday is 0=Mon … 6=Sun; [3] ⇒ Thu, [0,2] ⇒ Mon,Wed.
    expect(summarizeRecurrenceConfig(config({ byWeekday: [3] }))).toBe(
      'every Thu',
    );
    expect(summarizeRecurrenceConfig(config({ byWeekday: [0, 2] }))).toBe(
      'every Mon,Wed',
    );
  });

  it('renders a plain weekly (no weekday selector) as "weekly"', () => {
    expect(summarizeRecurrenceConfig(config({ byWeekday: null }))).toBe(
      'weekly',
    );
  });

  it('renders a >1 weekly interval as "every N weeks" (with/without days)', () => {
    expect(summarizeRecurrenceConfig(config({ interval: 2 }))).toBe(
      'every 2 weeks',
    );
    expect(
      summarizeRecurrenceConfig(config({ interval: 2, byWeekday: [3] })),
    ).toBe('every 2 weeks on Thu');
  });

  it('renders daily cadence (interval 1 vs N)', () => {
    expect(
      summarizeRecurrenceConfig(
        config({ frequency: RecurrenceFrequency.DAILY }),
      ),
    ).toBe('daily');
    expect(
      summarizeRecurrenceConfig(
        config({ frequency: RecurrenceFrequency.DAILY, interval: 3 }),
      ),
    ).toBe('every 3 days');
  });

  it('renders monthly cadence with a day-of-month selector', () => {
    expect(
      summarizeRecurrenceConfig(
        config({
          frequency: RecurrenceFrequency.MONTHLY,
          byMonthDay: [1],
        }),
      ),
    ).toBe('monthly day 1');
    expect(
      summarizeRecurrenceConfig(
        config({
          frequency: RecurrenceFrequency.MONTHLY,
          interval: 2,
          byMonthDay: [15],
        }),
      ),
    ).toBe('every 2 months day 15');
  });

  it('renders yearly cadence with month + day selectors', () => {
    // byMonth is 1-12 (Jul = 7).
    expect(
      summarizeRecurrenceConfig(
        config({
          frequency: RecurrenceFrequency.YEARLY,
          byMonth: [7],
          byMonthDay: [4],
        }),
      ),
    ).toBe('yearly Jul 4');
  });
});

describe('summarizeRecurrenceConfig — end condition', () => {
  it('appends an UNTIL date as "until <d LLL>"', () => {
    expect(
      summarizeRecurrenceConfig(
        config({
          byWeekday: [3],
          endType: RecurrenceEndType.UNTIL_DATE,
          endDate: '2026-08-01',
        }),
      ),
    ).toBe('every Thu until 1 Aug');
  });

  it('appends a COUNT as "xN"', () => {
    expect(
      summarizeRecurrenceConfig(
        config({ interval: 2, endType: RecurrenceEndType.COUNT, count: 10 }),
      ),
    ).toBe('every 2 weeks x10');
  });

  it('appends nothing for a NEVER-ending rule', () => {
    expect(summarizeRecurrenceConfig(config({ byWeekday: [3] }))).toBe(
      'every Thu',
    );
  });
});

describe('formatRecurrenceSummary — inline marker (glyph + source + edited)', () => {
  it('renders a task-owned rule with just the glyph + rule', () => {
    expect(formatRecurrenceSummary(summary({ byWeekday: [3] }), false)).toBe(
      '🔁 every Thu',
    );
  });

  it('renders a group-inherited rule with its source + group name', () => {
    expect(
      formatRecurrenceSummary(
        summary({ byWeekday: [3] }, RecurrenceSource.GROUP, 'Work'),
        false,
      ),
    ).toBe('🔁 every Thu inherited from group "Work"');
  });

  it('falls back to "group" when an inherited rule carries no name', () => {
    expect(
      formatRecurrenceSummary(
        summary({ byWeekday: [3] }, RecurrenceSource.GROUP, null),
        false,
      ),
    ).toBe('🔁 every Thu inherited from group "group"');
  });

  it('appends (edited) for an overridden instance', () => {
    expect(formatRecurrenceSummary(summary({ byWeekday: [3] }), true)).toBe(
      '🔁 every Thu (edited)',
    );
  });

  it('combines source + (edited) for a group-inherited overridden instance', () => {
    expect(
      formatRecurrenceSummary(
        summary(
          { frequency: RecurrenceFrequency.MONTHLY, byMonthDay: [1] },
          RecurrenceSource.GROUP,
          'Chores',
        ),
        true,
      ),
    ).toBe('🔁 monthly day 1 inherited from group "Chores" (edited)');
  });
});
