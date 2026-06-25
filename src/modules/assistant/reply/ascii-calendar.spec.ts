import { DateTime } from 'luxon';

import {
  ASCII_CALENDAR_MAX_WIDTH,
  renderAsciiCalendar,
} from './ascii-calendar';
import { Task } from '@/modules/database/entities';
import { Occurrence } from '@/modules/recurrence-rule/recurrence.types';

/** Builds a minimal timed one-off occurrence at the given absolute instant. */
const timed = (title: string, startIso: string, zone: string): Occurrence => {
  const start = DateTime.fromISO(startIso, { zone }).toJSDate();

  return {
    task: { id: title, isAllDay: false } as Task,
    originalStart: start,
    occurrenceStart: start,
    occurrenceEnd: null,
    title,
    completedAt: null,
    isRecurring: false,
    isException: false,
    recurrence: null,
  };
};

/** Builds a minimal all-day one-off occurrence on the given local date. */
const allDay = (title: string, dateIso: string, zone: string): Occurrence => {
  const start = DateTime.fromISO(dateIso, { zone }).startOf('day').toJSDate();

  return {
    task: { id: title, isAllDay: true } as Task,
    originalStart: start,
    occurrenceStart: start,
    occurrenceEnd: null,
    title,
    completedAt: null,
    isRecurring: false,
    isException: false,
    recurrence: null,
  };
};

/** Builds a timeless todo occurrence (null start). */
const todo = (title: string): Occurrence => ({
  task: { id: title, isAllDay: false } as Task,
  originalStart: null,
  occurrenceStart: null,
  occurrenceEnd: null,
  title,
  completedAt: null,
  isRecurring: false,
  isException: false,
  recurrence: null,
});

describe('renderAsciiCalendar', () => {
  const zone = 'UTC';
  const from = DateTime.fromISO('2026-06-21T00:00:00', { zone }).toJSDate();
  const to = DateTime.fromISO('2026-06-22T00:00:00', { zone }).toJSDate();

  it('renders a one-day window with a header, the title, and the local time', () => {
    const calendar = renderAsciiCalendar({
      title: 'Today',
      from,
      to,
      occurrences: [timed('Standup', '2026-06-21T09:00:00', zone)],
      timezone: zone,
    });

    expect(calendar).toContain('Today');
    expect(calendar).toContain('Sun 21 Jun');
    expect(calendar).toContain('09:00 Standup');
  });

  it('keeps EVERY line within the mobile width budget (≤ 30 chars), truncating long titles with an ellipsis', () => {
    const calendar = renderAsciiCalendar({
      title: 'Today',
      from,
      to,
      occurrences: [
        timed(
          'A very very very long meeting title that must be truncated',
          '2026-06-21T14:30:00',
          zone,
        ),
      ],
      timezone: zone,
    });

    for (const line of calendar.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(ASCII_CALENDAR_MAX_WIDTH + 2);
    }

    // The occurrence line itself (after the 2-space indent) is bounded and ends ….
    const occurrenceLine = calendar
      .split('\n')
      .find((line) => line.includes('14:30'))!
      .trimStart();

    expect(occurrenceLine.length).toBeLessThanOrEqual(ASCII_CALENDAR_MAX_WIDTH);
    expect(occurrenceLine.endsWith('…')).toBe(true);
  });

  it('formats times in the USER timezone, not UTC (DST-correct on an absolute instant)', () => {
    // 09:00 in Kyiv (UTC+3 in June) is 06:00 UTC — assert the local 09:00 shows.
    const kyiv = 'Europe/Kyiv';
    const calendar = renderAsciiCalendar({
      title: 'Today',
      from: DateTime.fromISO('2026-06-21T00:00:00', { zone: kyiv }).toJSDate(),
      to: DateTime.fromISO('2026-06-22T00:00:00', { zone: kyiv }).toJSDate(),
      occurrences: [timed('Standup', '2026-06-21T09:00:00', kyiv)],
      timezone: kyiv,
    });

    expect(calendar).toContain('09:00 Standup');
    expect(calendar).not.toContain('06:00');
  });

  it('renders an all-day item and a timeless todo distinctly', () => {
    const calendar = renderAsciiCalendar({
      title: 'Today',
      from,
      to,
      occurrences: [allDay('Holiday', '2026-06-21', zone), todo('Buy milk')],
      timezone: zone,
    });

    expect(calendar).toContain('all-day Holiday');
    expect(calendar).toContain('• Buy milk');
  });

  it('marks a day with no occurrences as free across a multi-day window, listing each day', () => {
    const weekFrom = DateTime.fromISO('2026-06-21T00:00:00', {
      zone,
    }).toJSDate();
    const weekTo = DateTime.fromISO('2026-06-24T00:00:00', {
      zone,
    }).toJSDate();

    const calendar = renderAsciiCalendar({
      title: 'Next 3 days',
      from: weekFrom,
      to: weekTo,
      occurrences: [timed('Dentist', '2026-06-22T11:00:00', zone)],
      timezone: zone,
    });

    // Three day headers (21st free, 22nd has the dentist, 23rd free).
    expect(calendar).toContain('Sun 21 Jun');
    expect(calendar).toContain('Mon 22 Jun');
    expect(calendar).toContain('Tue 23 Jun');
    expect(calendar).toContain('11:00 Dentist');
    expect(calendar).toContain('(nothing scheduled)');
  });
});
