import { Occurrence } from '@/modules/recurrence-rule/recurrence.types';

/**
 * The coordinate a per-turn handle resolves to. A recurring occurrence carries a
 * non-null `originalStart` (the stable `(taskId, originalStart)` instance id the
 * recurrence-expansion edit ops take); a one-off task or timeless todo carries
 * `null`, addressing the row / series master directly.
 */
export interface HandleTarget {
  taskId: string;
  originalStart: Date | null;
}

/** Prefix for minted aliases (`e` for "entry", per the assistant-task-tools spec). */
const HANDLE_PREFIX = 'e';

/**
 * A per-turn map of compact ordinal aliases (`e1`, `e2`, …) to the task /
 * occurrence coordinate they address. One instance is created per user turn by
 * the orchestrator: the context builder seeds it while rendering the agenda and
 * `list_tasks` appends to it during the tool loop, so aliases keep counting up
 * within the turn and never collide. The model only ever sees the alias — raw
 * task UUIDs never leak into model-visible text.
 */
export class HandleMap {
  private nextOrdinal = 1;

  private readonly targets = new Map<string, HandleTarget>();

  /**
   * Mints the next sequential alias for `target`, stores it, and returns the
   * alias string.
   */
  add(target: HandleTarget): string {
    const alias = `${HANDLE_PREFIX}${this.nextOrdinal}`;

    this.nextOrdinal += 1;
    this.targets.set(alias, target);

    return alias;
  }

  /**
   * Convenience over {@link add} for an {@link Occurrence}: a recurring instance
   * keeps its `originalStart`; a one-off / todo resolves to `null`.
   */
  addOccurrence(occurrence: Occurrence): string {
    return this.add({
      taskId: occurrence.task.id,
      originalStart: occurrence.originalStart,
    });
  }

  /**
   * Resolves an alias to its target, or `undefined` when the alias was never
   * minted in this turn (a stale cross-turn reference or one the model invented).
   */
  resolve(alias: string): HandleTarget | undefined {
    return this.targets.get(alias);
  }
}
