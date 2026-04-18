import { Column, Entity } from 'typeorm';

import { BaseEntity } from './base.entity';

/**
 * Supported recurrence frequencies, modelled on a simplified subset of RFC 5545 RRULE.
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

/**
 * RecurrenceRule entity describing how a task repeats over time.
 * Modelled on a simplified subset of RFC 5545 RRULE semantics.
 *
 * Weekday encoding for `byWeekday`: 0 = Monday, 1 = Tuesday, … 6 = Sunday (ISO-8601 ordering).
 */
@Entity()
export class RecurrenceRule extends BaseEntity {
  @Column({ type: 'enum', enum: RecurrenceFrequency })
  frequency: RecurrenceFrequency;

  @Column({ type: 'int', default: 1 })
  interval: number;

  /**
   * Array of weekday ordinals using ISO-8601 indexing (0 = Monday … 6 = Sunday).
   * Null means the rule is not restricted by weekday.
   */
  @Column({ type: 'int', array: true, nullable: true })
  byWeekday: number[] | null;

  /**
   * Array of days of the month (1-31). Null means no month-day restriction.
   */
  @Column({ type: 'int', array: true, nullable: true })
  byMonthDay: number[] | null;

  /**
   * Array of months (1-12). Null means no month restriction.
   */
  @Column({ type: 'int', array: true, nullable: true })
  byMonth: number[] | null;

  @Column({
    type: 'enum',
    enum: RecurrenceEndType,
    default: RecurrenceEndType.NEVER,
  })
  endType: RecurrenceEndType;

  @Column({ type: 'date', nullable: true })
  endDate: string | null;

  @Column({ type: 'int', nullable: true })
  count: number | null;
}
