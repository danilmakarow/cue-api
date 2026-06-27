import { DateTime } from 'luxon';

import {
  MonthlyAnchorMode,
  RecurrenceConfig,
  RecurrenceSource,
  RecurrenceSummary,
} from './recurrence.types';
import {
  RecurrenceEndType,
  RecurrenceFrequency,
} from '@/modules/database/entities';

/**
 * Three-letter weekday labels indexed by the entity weekday encoding
 * (0 = Monday … 6 = Sunday), so `byWeekday` ordinals map straight to a name
 * without going through luxon.
 */
const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Three-letter month labels indexed 1-12 (index 0 unused) for `byMonth`. */
const MONTH_LABELS = [
  '',
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/**
 * Ordinal words for a `bySetPos` value (1..4 = first..fourth, -1 = last), so a
 * nth-weekday rule renders as "first Mon" / "last Fri" rather than a raw number.
 */
const SET_POS_LABELS: Record<number, string> = {
  [-1]: 'last',
  1: 'first',
  2: 'second',
  3: 'third',
  4: 'fourth',
};

/** Compact human label for each working-day {@link MonthlyAnchorMode}. */
const MONTHLY_ANCHOR_LABELS: Record<MonthlyAnchorMode, string> = {
  [MonthlyAnchorMode.FIRST_WORKDAY]: 'first workday',
  [MonthlyAnchorMode.LAST_WORKDAY]: 'last workday',
  [MonthlyAnchorMode.DAY_BEFORE_LAST_WORKDAY]: 'day before last workday',
};

/**
 * Renders the MONTHLY day selector as compact text, honoring selector precedence:
 * working-day anchor → nth-weekday (`bySetPos` × `byWeekday`) → `byMonthDay` →
 * none. Returns null when the month has no explicit day selector (plain monthly).
 */
const summarizeMonthlySelector = (config: RecurrenceConfig): string | null => {
  if (config.monthlyAnchor) return MONTHLY_ANCHOR_LABELS[config.monthlyAnchor];

  if (
    config.bySetPos &&
    config.bySetPos.length > 0 &&
    config.byWeekday &&
    config.byWeekday.length > 0
  ) {
    const days = config.byWeekday
      .map((ordinal) => WEEKDAY_LABELS[ordinal] ?? `?${ordinal}`)
      .join(',');

    return config.bySetPos
      .map((setPos) => `${SET_POS_LABELS[setPos] ?? setPos} ${days}`)
      .join(', ');
  }

  if (config.byMonthDay && config.byMonthDay.length > 0) {
    return `day ${config.byMonthDay.join(',')}`;
  }

  return null;
};

/**
 * Renders the per-frequency core of a rule (the cadence + any `by*` selector) as
 * compact human text: `every Thu`, `every 2 weeks`, `daily`, `monthly day 1`,
 * `yearly Jul 4`. The interval is shown only when greater than one so the common
 * `interval: 1` reads naturally ("weekly on Thu", not "every 1 weeks").
 */
const summarizeCadence = (config: RecurrenceConfig): string => {
  const interval = config.interval >= 1 ? config.interval : 1;

  if (config.frequency === RecurrenceFrequency.WEEKLY) {
    const days =
      config.byWeekday && config.byWeekday.length > 0
        ? config.byWeekday
            .map((ordinal) => WEEKDAY_LABELS[ordinal] ?? `?${ordinal}`)
            .join(',')
        : null;

    if (interval === 1) return days ? `every ${days}` : 'weekly';

    return days
      ? `every ${interval} weeks on ${days}`
      : `every ${interval} weeks`;
  }

  if (config.frequency === RecurrenceFrequency.MONTHLY) {
    const selector = summarizeMonthlySelector(config);
    const cadence = interval === 1 ? 'monthly' : `every ${interval} months`;

    return selector ? `${cadence} ${selector}` : cadence;
  }

  if (config.frequency === RecurrenceFrequency.YEARLY) {
    const months =
      config.byMonth && config.byMonth.length > 0
        ? config.byMonth.map((month) => MONTH_LABELS[month] ?? `?${month}`)
        : null;
    const days =
      config.byMonthDay && config.byMonthDay.length > 0
        ? config.byMonthDay
        : null;
    const cadence = interval === 1 ? 'yearly' : `every ${interval} years`;

    if (months && days) {
      return `${cadence} ${months.join(',')} ${days.join(',')}`;
    }

    if (months) return `${cadence} ${months.join(',')}`;

    return cadence;
  }

  // DAILY
  return interval === 1 ? 'daily' : `every ${interval} days`;
};

/**
 * Renders the rule's end condition as compact human text, or null when the rule
 * never terminates: `until 1 Aug` for an `UNTIL_DATE`, `x10` for a `COUNT`. The
 * date is formatted day-then-month (`1 Aug`) so it stays terse and unambiguous.
 */
const summarizeEnd = (config: RecurrenceConfig): string | null => {
  if (config.endType === RecurrenceEndType.UNTIL_DATE && config.endDate) {
    const date = DateTime.fromISO(config.endDate);

    if (date.isValid) return `until ${date.toFormat('d LLL')}`;

    return `until ${config.endDate}`;
  }

  if (config.endType === RecurrenceEndType.COUNT && config.count !== null) {
    return `x${config.count}`;
  }

  return null;
};

/**
 * Summarizes a {@link RecurrenceConfig} into one compact, model-readable line:
 * the cadence + selector, an end condition when the rule terminates. Pure and
 * tz-free (the cadence is a rule, not an instant). Reused by the assistant
 * formatter so every recurring task line carries the same byte-consistent rule
 * text. Does NOT include the source/marker — {@link formatRecurrenceSummary}
 * decorates it with those.
 */
export const summarizeRecurrenceConfig = (config: RecurrenceConfig): string => {
  const cadence = summarizeCadence(config);
  const end = summarizeEnd(config);

  return end ? `${cadence} ${end}` : cadence;
};

/**
 * Renders the full inline recurrence marker for a recurring occurrence: the
 * repeat glyph, the rule text ({@link summarizeRecurrenceConfig}), the rule
 * SOURCE (`inherited from group "<name>"` when group-inherited, nothing when
 * task-owned), and an `(edited)` marker when this specific instance carries an
 * override (`isException`). Returns a single space-joined fragment the formatter
 * appends to a task line, e.g. `🔁 every Thu until 1 Aug inherited from group
 * "Work" (edited)`.
 */
export const formatRecurrenceSummary = (
  summary: RecurrenceSummary,
  isException: boolean,
): string => {
  const parts = [`🔁 ${summarizeRecurrenceConfig(summary.config)}`];

  if (summary.source === RecurrenceSource.GROUP) {
    const name = summary.groupName ?? 'group';

    parts.push(`inherited from group "${name}"`);
  }

  if (isException) parts.push('(edited)');

  return parts.join(' ');
};
