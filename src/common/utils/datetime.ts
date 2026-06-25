import { DateTime } from 'luxon';

/**
 * Parses an ISO datetime string into an absolute `Date`, interpreting a NAIVE
 * wall-clock string (no offset / `Z`, e.g. `2026-06-25T14:30:00`) as a local
 * time in the IANA `zone`, while HONORING an explicit in-string offset / `Z`
 * when one is present (luxon's `fromISO` only falls back to the `zone` option
 * for offset-less inputs). This is the WRITE-boundary inverse of the read-side
 * `setZone(user.timezone)`: an assistant emits naive wall-clock times in the
 * user's timezone, so on a UTC server `14:30` for a Moscow (UTC+3) user must be
 * stored as `11:30Z`, not `14:30Z`.
 *
 * Returns `null` for an empty or unparseable input so callers can treat it the
 * same as an absent value (matching the prior `dto.x ? new Date(dto.x) : null`
 * shape), rather than persisting an `Invalid Date`.
 */
export const parseWallClockInZone = (
  input: string,
  zone: string,
): Date | null => {
  if (!input) return null;

  const dateTime = DateTime.fromISO(input, { zone });

  if (!dateTime.isValid) return null;

  return dateTime.toJSDate();
};
