import { DateTime } from 'luxon';

import { formatRecurrenceSummary } from '@/modules/recurrence-rule/recurrence-summary';
import { Occurrence } from '@/modules/recurrence-rule/recurrence.types';

/**
 * Builds the trailing recurrence-context fragment for a line, or '' when the
 * occurrence is a one-off / todo (no `recurrence` summary). For a recurring
 * occurrence it renders a leading-space marker — the repeat glyph, the rule, its
 * end condition, the source (task-owned vs `inherited from group "<name>"`), and
 * an `(edited)` marker for an overridden instance — so the model reads the full
 * recurrence context inline (e.g. ` 🔁 every Thu until 1 Aug (edited)`).
 */
const recurrenceSuffix = (occurrence: Occurrence): string => {
  if (!occurrence.recurrence) return '';

  return ` ${formatRecurrenceSummary(occurrence.recurrence, occurrence.isException)}`;
};

/**
 * Formats a single occurrence compactly, optionally prefixed with its per-turn
 * handle (`[e2] ...`) so the model can address it. Renders a timed window
 * (`[e2] ccc dd LLL HH:mm–HH:mm title`), an all-day form, or — for a timeless
 * todo (null start) — a no-time `todo: title` form. A recurring occurrence (own
 * or group-inherited rule) additionally carries a trailing recurrence marker
 * (`🔁 <rule> [<end>] [inherited from group "<name>"] [(edited)]`) so the model
 * sees its rule, end, source, and per-instance override inline rather than
 * reading it as a one-off. Shared by the context builder, `list_tasks`, and the
 * slash-command agenda so their schedule rendering stays byte-consistent (a
 * divergence would split the prompt cache).
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

  const suffix = recurrenceSuffix(occurrence);

  if (occurrence.task.isAllDay) {
    const day = DateTime.fromJSDate(occurrence.occurrenceStart)
      .setZone(timezone)
      .toFormat('ccc dd LLL');

    return `${prefix}${day} all-day ${occurrence.title}${suffix}`;
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

  return `${prefix}${window} ${occurrence.title}${suffix}`;
};
