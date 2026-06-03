import type { Task } from '@/modules/database/entities';

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
   * True when the occurrence was produced by a recurrence rule — whether the
   * task's own (`task.recurrenceRuleId != null`) or one inherited from its group
   * default (in which case `task.recurrenceRuleId` is null).
   */
  isRecurring: boolean;
  /** True when a `TaskOccurrenceException` row was applied to this instance. */
  isException: boolean;
}
