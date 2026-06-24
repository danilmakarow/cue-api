/**
 * Supported recurrence frequencies, modelled on a simplified subset of RFC 5545 RRULE.
 *
 * Kept as standalone enums (no longer an entity) because recurrence is now an
 * inline JSONB config on Task / TaskGroup (`recurrenceConfig`) rather than a
 * separate `recurrence_rule` table. Re-exported from `entities/index.ts` so
 * existing imports (`@/modules/database/entities`) keep resolving.
 */
export enum RecurrenceFrequency {
  DAILY = 'DAILY',
  WEEKLY = 'WEEKLY',
  MONTHLY = 'MONTHLY',
  YEARLY = 'YEARLY',
}

/**
 * How a recurrence terminates: never, on a specific date, or after a fixed number of occurrences.
 */
export enum RecurrenceEndType {
  NEVER = 'NEVER',
  UNTIL_DATE = 'UNTIL_DATE',
  COUNT = 'COUNT',
}
