import { DateTime } from 'luxon';

import { Occurrence } from '@/modules/recurrence-rule/recurrence.types';

/**
 * Formats a single occurrence compactly, optionally prefixed with its per-turn
 * handle (`[e2] ...`) so the model can address it. Renders a timed window
 * (`[e2] ccc dd LLL HH:mm–HH:mm title`), an all-day form, or — for a timeless
 * todo (null start) — a no-time `todo: title` form. Shared by the context
 * builder, `list_tasks`, and the slash-command agenda so their schedule
 * rendering stays byte-consistent (a divergence would split the prompt cache).
 */
export const formatTaskLine = (
  occurrence: Occurrence,
  timezone: string,
  alias?: string,
): string => {
  const prefix = alias ? `[${alias}] ` : '';

  if (occurrence.occurrenceStart === null) {
    return `${prefix}todo: ${occurrence.title}`;
  }

  if (occurrence.task.isAllDay) {
    const day = DateTime.fromJSDate(occurrence.occurrenceStart)
      .setZone(timezone)
      .toFormat('ccc dd LLL');

    return `${prefix}${day} all-day ${occurrence.title}`;
  }

  const start = DateTime.fromJSDate(occurrence.occurrenceStart)
    .setZone(timezone)
    .toFormat('ccc dd LLL HH:mm');
  const end = occurrence.occurrenceEnd
    ? DateTime.fromJSDate(occurrence.occurrenceEnd)
        .setZone(timezone)
        .toFormat('HH:mm')
    : '';
  const window = end ? `${start}–${end}` : start;

  return `${prefix}${window} ${occurrence.title}`;
};
