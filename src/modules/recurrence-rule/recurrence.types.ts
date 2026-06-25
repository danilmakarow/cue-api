import type {
  RecurrenceEndType,
  RecurrenceFrequency,
  Task,
} from '@/modules/database/entities';

/**
 * Inline recurrence configuration stored as JSONB on a `Task` or `TaskGroup`
 * (`recurrenceConfig`). A plain POJO — never a persisted entity row — mirroring
 * `CreateRecurrenceRuleDto` field-for-field (RFC-5545-lite). It is the single
 * value the expansion engine reads; the `Create/UpdateRecurrenceRuleDto` shapes
 * remain only as the class-validator validation surface for the JSONB payload.
 *
 * Weekday encoding for `byWeekday`: 0 = Monday … 6 = Sunday (ISO-8601 ordering).
 */
export interface RecurrenceConfig {
  /** How often the series repeats. */
  frequency: RecurrenceFrequency;
  /** Repeat every N periods of the frequency (>= 1). */
  interval: number;
  /** Weekday ordinals (0 = Monday … 6 = Sunday); null means no weekday restriction. */
  byWeekday: number[] | null;
  /** Days of the month (1-31); null means no month-day restriction. */
  byMonthDay: number[] | null;
  /** Months (1-12); null means no month restriction. */
  byMonth: number[] | null;
  /** How the series terminates. */
  endType: RecurrenceEndType;
  /** ISO date the series ends on; non-null only for `UNTIL_DATE`. */
  endDate: string | null;
  /** Number of occurrences; non-null only for `COUNT`. */
  count: number | null;
}

/**
 * Where a recurring occurrence's effective rule comes from: the task's own inline
 * `recurrenceConfig` (`TASK`) or the one inherited from its group default
 * (`GROUP`). Surfaced so a reader can tell an owned series from an inherited one.
 */
export enum RecurrenceSource {
  TASK = 'TASK',
  GROUP = 'GROUP',
}

/**
 * The recurrence context attached to a recurring {@link Occurrence}: the EFFECTIVE
 * rule that generated it (task-owned or group-inherited), where that rule comes
 * from, and — when inherited — the group's name. A value, never a persisted row;
 * it is what lets a reader (the assistant formatter) render the rule, its end
 * condition, and its source inline rather than treating a recurring instance as a
 * one-off. Null on a one-off / todo occurrence (carried via {@link Occurrence}).
 */
export interface RecurrenceSummary {
  /** The effective rule expanded into this occurrence (task own ?? group default). */
  config: RecurrenceConfig;
  /** Whether the rule is the task's own or inherited from its group default. */
  source: RecurrenceSource;
  /** The owning group's name; non-null only when `source` is `GROUP`. */
  groupName: string | null;
}

/**
 * A single computed instance of a task within a query window.
 *
 * An `Occurrence` is a value, never a persisted row: a one-off task yields one
 * `Occurrence` mirroring the row, and a recurring task yields one per generated
 * instance. Its stable identity is `(task.id, originalStart)` — exactly the
 * `TaskOccurrenceException` unique key — so per-instance edits and completions
 * address the same coordinate the rule generated.
 */
export interface Occurrence {
  /** The anchor row — the series master, or the one-off task itself. */
  task: Task;
  /**
   * Rule-generated start BEFORE any override is applied; the stable instance id.
   * Null only for a timeless todo surfaced via `includeTodos`; always non-null
   * for timed events and every recurring occurrence.
   */
  originalStart: Date | null;
  /**
   * Effective start with any `overrideStartAt` applied. Null only for a timeless
   * todo surfaced via `includeTodos`; always non-null for timed events and every
   * recurring occurrence.
   */
  occurrenceStart: Date | null;
  /** Effective end with any `overrideEndAt` applied; null for todos / open-ended instances. */
  occurrenceEnd: Date | null;
  /** Effective title with any `overrideTitle` applied. */
  title: string;
  /** Per-instance completion for recurring tasks; `task.completedAt` for one-offs. */
  completedAt: Date | null;
  /**
   * True when the occurrence was produced by a recurrence config — whether the
   * task's own (`task.recurrenceConfig != null`) or one inherited from its group
   * default (in which case `task.recurrenceConfig` is null).
   */
  isRecurring: boolean;
  /** True when a `TaskOccurrenceException` row was applied to this instance. */
  isException: boolean;
  /**
   * The recurrence context for a recurring occurrence — the effective rule, its
   * source (task-owned vs group-inherited), and the group name when inherited.
   * Null on a one-off / todo occurrence (`isRecurring === false`). Lets a reader
   * render the rule + source inline instead of treating it as a one-off.
   */
  recurrence: RecurrenceSummary | null;
}
