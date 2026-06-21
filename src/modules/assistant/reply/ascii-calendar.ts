import { DateTime } from 'luxon';

import { Occurrence } from '@/modules/recurrence-rule/recurrence.types';

/**
 * Target maximum width (characters) of any rendered line, sized for a phone in a
 * monospace code block (Verified Telegram facts: a reply-keyboard surface is
 * private-chat phone UX). Titles are truncated with an ellipsis to keep every
 * line within this bound. Story 16 acceptance: "≤ ~30 chars/line for mobile
 * width".
 */
export const ASCII_CALENDAR_MAX_WIDTH = 30;

/** Ellipsis appended to a truncated title (one char so the budget math is exact). */
const ELLIPSIS = '…';

/**
 * Truncates a title so the WHOLE line (a fixed prefix + the title) fits within
 * {@link ASCII_CALENDAR_MAX_WIDTH}. When the prefix alone already meets/exceeds
 * the budget (degenerate, e.g. a very long time form) the title is dropped to a
 * single ellipsis rather than producing a negative slice.
 */
const fitTitle = (prefix: string, title: string): string => {
  const budget = ASCII_CALENDAR_MAX_WIDTH - prefix.length;

  if (title.length <= budget) {
    return title;
  }

  if (budget <= ELLIPSIS.length) {
    return ELLIPSIS;
  }

  return `${title.slice(0, budget - ELLIPSIS.length)}${ELLIPSIS}`;
};

/**
 * Renders one occurrence as a compact, width-bounded line under its day header:
 * a timed event as `HH:mm Title`, an all-day item as `all-day Title`, and a
 * timeless todo as `• Title`. The title is truncated to keep the line within the
 * mobile width budget. Times are formatted in the user's timezone (DST-correct,
 * since the occurrence start is an absolute instant).
 */
const renderOccurrenceLine = (
  occurrence: Occurrence,
  timezone: string,
): string => {
  if (occurrence.occurrenceStart === null) {
    return `• ${fitTitle('• ', occurrence.title)}`;
  }

  if (occurrence.task.isAllDay) {
    return `all-day ${fitTitle('all-day ', occurrence.title)}`;
  }

  const time = DateTime.fromJSDate(occurrence.occurrenceStart)
    .setZone(timezone)
    .toFormat('HH:mm');
  const prefix = `${time} `;

  return `${prefix}${fitTitle(prefix, occurrence.title)}`;
};

/**
 * Groups occurrences onto their LOCAL date (`yyyy-LL-dd` in the user's timezone)
 * so the calendar is bucketed by the day the user perceives, not UTC. A timeless
 * todo (null start) is bucketed under the window's first day so it still surfaces.
 */
const groupByLocalDate = (
  occurrences: Occurrence[],
  timezone: string,
  fallbackIsoDate: string,
): Map<string, Occurrence[]> => {
  const groups = new Map<string, Occurrence[]>();

  for (const occurrence of occurrences) {
    const isoDate =
      occurrence.occurrenceStart === null
        ? fallbackIsoDate
        : DateTime.fromJSDate(occurrence.occurrenceStart)
            .setZone(timezone)
            .toFormat('yyyy-LL-dd');

    const bucket = groups.get(isoDate) ?? [];

    bucket.push(occurrence);
    groups.set(isoDate, bucket);
  }

  return groups;
};

/**
 * Renders a monospace ASCII calendar for the half-open window `[from, to)` from a
 * pre-fetched, time-sorted list of {@link Occurrence}s, in the user's timezone
 * (Story 16 / ADR 0045). Deterministic — NO LLM. One `ccc dd LLL` day header per
 * day in the window (so empty days read as "free"), each followed by its bucketed
 * occurrence lines, with `(nothing scheduled)` under a free day. Every line is
 * kept within {@link ASCII_CALENDAR_MAX_WIDTH} for mobile width (titles truncated
 * with an ellipsis). The result is meant to be wrapped in a monospace code block
 * by the caller so columns align.
 *
 * `title` is the leading caption (e.g. "Today" / "Next 7 days"). The window is
 * iterated by LOCAL calendar day so a multi-day range lists each day even when it
 * holds nothing.
 */
export const renderAsciiCalendar = (params: {
  title: string;
  from: Date;
  to: Date;
  occurrences: Occurrence[];
  timezone: string;
}): string => {
  const { title, from, to, occurrences, timezone } = params;
  const startDay = DateTime.fromJSDate(from).setZone(timezone).startOf('day');
  const endDay = DateTime.fromJSDate(to).setZone(timezone).startOf('day');
  const fallbackIsoDate = startDay.toFormat('yyyy-LL-dd');
  const groups = groupByLocalDate(occurrences, timezone, fallbackIsoDate);

  const lines: string[] = [title];

  // Iterate each local day in [startDay, endDay); a half-open `to` that lands on a
  // day boundary excludes that final day, matching `findOccurrencesInRange`.
  for (let day = startDay; day < endDay; day = day.plus({ days: 1 })) {
    const isoDate = day.toFormat('yyyy-LL-dd');
    const dayOccurrences = groups.get(isoDate) ?? [];

    lines.push(day.toFormat('ccc dd LLL'));

    if (dayOccurrences.length === 0) {
      lines.push('  (nothing scheduled)');

      continue;
    }

    for (const occurrence of dayOccurrences) {
      lines.push(`  ${renderOccurrenceLine(occurrence, timezone)}`);
    }
  }

  return lines.join('\n');
};
