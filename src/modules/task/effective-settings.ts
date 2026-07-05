import { Task } from '@/modules/database/entities';
import { RecurrenceConfig } from '@/modules/recurrence-rule/recurrence.types';

/**
 * The settings that resolve task-wins over a task's group: each is the task's own
 * value when set, else the group's, else a hard default. Surfaced on task /
 * occurrence wire shapes so the client and assistant read one effective value
 * rather than re-implementing inheritance.
 */
export interface EffectiveSettings {
  /** Effective recurrence config: task own ?? group default ?? null. */
  recurrence: RecurrenceConfig | null;
  /** Effective completion requirement: task own ?? group default ?? false. */
  requiresCompletion: boolean;
  /** Effective color: task own ?? group default ?? null. */
  color: string | null;
}

/**
 * Resolves a task's effective settings with task-wins inheritance over its group
 * (mirrors the recurrence inheritance in `TaskService.readRecurringOccurrences`):
 * the task's own value wins, the group default is the fallback, and a hard
 * default applies when neither is set. `requiresCompletion` defaults to `false`
 * when set nowhere — that default lives HERE, never as a column default (ADR 0054).
 *
 * The group is read from the (optionally) loaded `task.group` relation; when the
 * relation is absent (a relation-less `findOneBy`) only the task's own values and
 * the hard defaults are visible — load `relations: { group: true }` to honor
 * group inheritance.
 */
export const resolveEffectiveSettings = (task: Task): EffectiveSettings => {
  const group = task.group ?? null;

  return {
    recurrence: resolveEffectiveRecurrence(task),
    requiresCompletion:
      task.requiresCompletion ?? group?.requiresCompletion ?? false,
    color: task.color ?? group?.color ?? null,
  };
};

/**
 * Resolves a task's effective recurrence config with one override-aware rule on
 * top of task-wins inheritance: an OVERRIDE CHILD (`parentTaskId` set) NEVER
 * recurs — it is a materialized one-off replacing a single generated slot, so it
 * must not expand (via its own config, which is disallowed anyway, nor via group
 * inheritance). Otherwise the task's own inline config wins, then the group
 * default, then null.
 *
 * This is the single gate every recurrence read passes through (the anchor scan
 * and `inheritsGroupRecurrence` enforce the same "children never recur"
 * invariant) so a child can never be double-counted or expanded as a series.
 */
export const resolveEffectiveRecurrence = (
  task: Task,
): RecurrenceConfig | null => {
  if (task.parentTaskId != null) return null;

  return task.recurrenceConfig ?? task.group?.recurrenceConfig ?? null;
};
