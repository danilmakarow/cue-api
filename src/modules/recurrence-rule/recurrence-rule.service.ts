import { Injectable, Logger } from '@nestjs/common';
import { DateTime } from 'luxon';

import { CreateRecurrenceRuleDto, UpdateRecurrenceRuleDto } from './dtos';
import { Occurrence } from './recurrence.types';
import {
  RecurrenceEndType,
  RecurrenceFrequency,
  RecurrenceRule,
  Task,
  TaskOccurrenceException,
} from '@/modules/database/entities';
import { RecurrenceRuleDatabaseService } from '@/modules/database/services';

/**
 * Hard ceiling on occurrences returned from a single expansion call. A window
 * that would yield more than this is almost certainly an over-wide range rather
 * than a real agenda; we return what fits and log a truncation warning.
 */
const MAX_OCCURRENCES_PER_WINDOW = 1000;

/**
 * Defensive ceiling on raw generation steps, independent of how many land
 * in-window, so a malformed rule can never spin the period loop forever.
 */
const MAX_GENERATION_STEPS = MAX_OCCURRENCES_PER_WINDOW * 64;

/**
 * How far ahead {@link RecurrenceRuleService.previewSeriesOccurrences} scans a
 * proposed (not-yet-persisted) recurring series when conflict-checking a write
 * (Story 9). A `NEVER`-ending or far-`UNTIL` rule is effectively infinite, so the
 * scan is bounded to this horizon from the proposed anchor; within it the
 * expander's own `MAX_OCCURRENCES_PER_WINDOW` cap still applies. Two years
 * comfortably covers any realistic booking intent while keeping the scan — and
 * the per-occurrence overlap probes it drives — finite and fast. A rule that
 * only first clashes beyond this horizon is a documented, accepted miss (the
 * read-side `check_availability` tool and the per-occurrence write check at
 * commit time remain the backstops); it can never hang.
 */
const PREVIEW_SERIES_HORIZON_DAYS = 730;

/** Milliseconds in a day, for the look-ahead horizon arithmetic. */
const MILLIS_PER_DAY = 86_400_000;

/**
 * A proposed recurring series whose occurrences must be conflict-checked before
 * it is persisted (Story 9). Mirrors the create/update payload: a concrete timed
 * anchor (`startAt` + `endAt`), the per-task timezone, and the validated rule
 * grammar. `endAt` is required — only a timed series (a concrete window) can
 * overlap; a recurring todo without an end is non-conflicting by construction
 * and is never previewed.
 */
export interface ProposedSeries {
  title: string;
  startAt: Date;
  endAt: Date;
  timezone: string;
  recurrence: CreateRecurrenceRuleDto;
}

/**
 * Maps a luxon `DateTime.weekday` (1 = Monday … 7 = Sunday) back to the entity
 * encoding (0 = Monday … 6 = Sunday).
 */
const luxonWeekdayToEntity = (luxonWeekday: number): number => luxonWeekday - 1;

/**
 * Produces the candidate starts within a single DAILY period: just the cursor
 * day carried at the seed's wall-clock time.
 */
const dailyCandidates = (periodStart: DateTime): DateTime[] => [periodStart];

/**
 * Produces the candidate starts within a single WEEKLY period. When `byWeekday`
 * is set the week (Monday-anchored) expands into one candidate per listed
 * weekday at the seed wall-clock time; otherwise the period cursor itself.
 */
const weeklyCandidates = (
  periodStart: DateTime,
  byWeekday: number[] | null,
): DateTime[] => {
  if (!byWeekday || byWeekday.length === 0) return [periodStart];

  // luxon `startOf('week')` is Monday, matching the entity's 0 = Monday axis, so
  // an entity weekday maps to a day offset from the week start directly.
  const weekStart = periodStart.startOf('week');

  return byWeekday.map((entityWeekday) =>
    weekStart.plus({ days: entityWeekday }).set({
      hour: periodStart.hour,
      minute: periodStart.minute,
      second: periodStart.second,
      millisecond: periodStart.millisecond,
    }),
  );
};

/**
 * Resolves a target day-of-month within the given month, returning null when the
 * day overflows the month (iCal BYMONTHDAY semantics: day 31 in a 30-day month
 * is skipped, never clamped).
 */
const dayInMonthOrNull = (
  monthStart: DateTime,
  day: number,
): DateTime | null => {
  const candidate = monthStart.set({ day });

  if (candidate.month !== monthStart.month) return null;

  return candidate;
};

/**
 * Produces the candidate starts within a single MONTHLY period. When
 * `byMonthDay` is set the month expands into one candidate per listed day (each
 * skipped if it overflows the month); otherwise the seed's day-of-month, also
 * skipped on overflow.
 */
const monthlyCandidates = (
  periodStart: DateTime,
  seed: DateTime,
  byMonthDay: number[] | null,
): DateTime[] => {
  const monthStart = periodStart.startOf('month');
  const days = byMonthDay && byMonthDay.length > 0 ? byMonthDay : [seed.day];

  return days
    .map((day) => dayInMonthOrNull(monthStart, day))
    .filter((candidate): candidate is DateTime => candidate !== null)
    .map((candidate) =>
      candidate.set({
        hour: seed.hour,
        minute: seed.minute,
        second: seed.second,
        millisecond: seed.millisecond,
      }),
    );
};

/**
 * Produces the candidate starts within a single YEARLY period. `byMonth` (or the
 * seed's month) selects the months; within each, `byMonthDay` (or the seed's
 * day) selects the days, skipping any day that overflows its month.
 */
const yearlyCandidates = (
  periodStart: DateTime,
  seed: DateTime,
  byMonth: number[] | null,
  byMonthDay: number[] | null,
): DateTime[] => {
  const months = byMonth && byMonth.length > 0 ? byMonth : [seed.month];
  const days = byMonthDay && byMonthDay.length > 0 ? byMonthDay : [seed.day];
  const candidates: DateTime[] = [];

  for (const month of months) {
    const monthStart = periodStart.set({ month, day: 1 }).startOf('day');

    for (const day of days) {
      const candidate = dayInMonthOrNull(monthStart, day);

      if (!candidate) continue;

      candidates.push(
        candidate.set({
          hour: seed.hour,
          minute: seed.minute,
          second: seed.second,
          millisecond: seed.millisecond,
        }),
      );
    }
  }

  return candidates;
};

/**
 * Applies the `by*` axes that act as limiting filters for the given frequency
 * (the axes a frequency does not already expand on). Returns true when the
 * candidate is allowed through.
 */
const passesLimitFilters = (
  candidate: DateTime,
  frequency: RecurrenceFrequency,
  rule: RecurrenceRule,
): boolean => {
  const limitsWeekday = frequency !== RecurrenceFrequency.WEEKLY;
  const limitsMonthDay =
    frequency !== RecurrenceFrequency.MONTHLY &&
    frequency !== RecurrenceFrequency.YEARLY;
  const limitsMonth = frequency !== RecurrenceFrequency.YEARLY;

  if (
    limitsWeekday &&
    rule.byWeekday &&
    rule.byWeekday.length > 0 &&
    !rule.byWeekday.includes(luxonWeekdayToEntity(candidate.weekday))
  ) {
    return false;
  }

  if (
    limitsMonthDay &&
    rule.byMonthDay &&
    rule.byMonthDay.length > 0 &&
    !rule.byMonthDay.includes(candidate.day)
  ) {
    return false;
  }

  if (
    limitsMonth &&
    rule.byMonth &&
    rule.byMonth.length > 0 &&
    !rule.byMonth.includes(candidate.month)
  ) {
    return false;
  }

  return true;
};

/**
 * Computes the sorted, de-duplicated candidate starts produced within one
 * period of the rule, already filtered by the limiting `by*` axes and dropping
 * anything before the series seed.
 */
const candidatesForPeriod = (
  periodStart: DateTime,
  seed: DateTime,
  rule: RecurrenceRule,
): DateTime[] => {
  const raw = (() => {
    if (rule.frequency === RecurrenceFrequency.DAILY) {
      return dailyCandidates(periodStart);
    }

    if (rule.frequency === RecurrenceFrequency.WEEKLY) {
      return weeklyCandidates(periodStart, rule.byWeekday);
    }

    if (rule.frequency === RecurrenceFrequency.MONTHLY) {
      return monthlyCandidates(periodStart, seed, rule.byMonthDay);
    }

    return yearlyCandidates(periodStart, seed, rule.byMonth, rule.byMonthDay);
  })();

  const seedMillis = seed.toMillis();
  const seen = new Set<number>();
  const filtered: DateTime[] = [];

  for (const candidate of raw) {
    const millis = candidate.toMillis();

    if (millis < seedMillis) continue;
    if (seen.has(millis)) continue;
    if (!passesLimitFilters(candidate, rule.frequency, rule)) continue;

    seen.add(millis);
    filtered.push(candidate);
  }

  return filtered.sort((left, right) => left.toMillis() - right.toMillis());
};

/**
 * Service for RecurrenceRule CRUD and the pure on-read expansion engine.
 * Expansion never materializes occurrences and carries no DB dependency.
 */
@Injectable()
export class RecurrenceRuleService {
  private readonly logger = new Logger(RecurrenceRuleService.name);

  constructor(
    private readonly recurrenceRuleDatabaseService: RecurrenceRuleDatabaseService,
  ) {}

  /**
   * Advances a period cursor by one `frequency × interval` step.
   */
  private stepPeriod(cursor: DateTime, rule: RecurrenceRule): DateTime {
    const interval = rule.interval >= 1 ? rule.interval : 1;

    if (rule.frequency === RecurrenceFrequency.DAILY) {
      return cursor.plus({ days: interval });
    }

    if (rule.frequency === RecurrenceFrequency.WEEKLY) {
      return cursor.plus({ weeks: interval });
    }

    if (rule.frequency === RecurrenceFrequency.MONTHLY) {
      return cursor.plus({ months: interval });
    }

    return cursor.plus({ years: interval });
  }

  /**
   * Resolves the inclusive UNTIL boundary (end of the rule's `endDate` day) in
   * the anchor timezone, or null when the rule does not terminate by date.
   */
  private untilBoundaryMillis(
    rule: RecurrenceRule,
    zone: string,
  ): number | null {
    if (rule.endType !== RecurrenceEndType.UNTIL_DATE || !rule.endDate) {
      return null;
    }

    const boundary = DateTime.fromISO(rule.endDate, { zone });

    if (!boundary.isValid) return null;

    return boundary.endOf('day').toMillis();
  }

  /**
   * Builds the Occurrence for a generated instant, applying any matching
   * exception (skip is handled by the caller; this assumes the instance is kept).
   */
  private buildOccurrence(
    anchor: Task,
    originalStart: Date,
    durationMillis: number | null,
    exception: TaskOccurrenceException | undefined,
  ): Occurrence {
    const occurrenceStart = exception?.overrideStartAt ?? originalStart;
    const defaultEnd =
      durationMillis !== null
        ? new Date(occurrenceStart.getTime() + durationMillis)
        : null;
    const occurrenceEnd = exception?.overrideEndAt ?? defaultEnd;

    return {
      task: anchor,
      originalStart,
      occurrenceStart,
      occurrenceEnd,
      title: exception?.overrideTitle ?? anchor.title,
      completedAt: exception?.completedAt ?? null,
      isRecurring: true,
      isException: exception !== undefined,
    };
  }

  /**
   * Expands a recurring anchor into the concrete occurrences that intersect the
   * half-open window `[windowFrom, windowTo)`, with exceptions applied. Pure: it
   * takes the already-loaded exceptions and performs no I/O.
   *
   * All date math runs in `anchor.timezone` via luxon, so wall-clock time is
   * preserved across DST transitions. Timed occurrences keep their local time;
   * all-day occurrences are date-anchored (their wall clock is midnight, which
   * luxon stepping preserves).
   *
   * COUNT is counted from the series origin (window-independent); generation
   * stops at the earliest of `windowTo`, the COUNT cap, or the UNTIL boundary.
   * The result is capped at `MAX_OCCURRENCES_PER_WINDOW`, logging a truncation
   * warning rather than silently dropping.
   */
  expandOccurrences(
    anchor: Task,
    rule: RecurrenceRule,
    exceptions: TaskOccurrenceException[],
    windowFrom: Date,
    windowTo: Date,
  ): Occurrence[] {
    if (!anchor.startAt) return [];

    const zone = anchor.timezone;
    const seed = DateTime.fromJSDate(anchor.startAt, { zone });

    if (!seed.isValid) return [];

    const durationMillis =
      anchor.endAt !== null
        ? anchor.endAt.getTime() - anchor.startAt.getTime()
        : null;
    const exceptionsByOriginalStart = this.indexExceptions(exceptions);
    const windowFromMillis = windowFrom.getTime();
    const windowToMillis = windowTo.getTime();
    const untilMillis = this.untilBoundaryMillis(rule, zone);
    const hasCount =
      rule.endType === RecurrenceEndType.COUNT && rule.count !== null;
    const countLimit = hasCount ? (rule.count as number) : null;

    const occurrences: Occurrence[] = [];
    let periodCursor = seed;
    let generatedCount = 0;
    let generationSteps = 0;
    let truncated = false;

    while (generationSteps < MAX_GENERATION_STEPS) {
      const candidates = candidatesForPeriod(periodCursor, seed, rule);

      for (const candidate of candidates) {
        const candidateMillis = candidate.toMillis();

        if (untilMillis !== null && candidateMillis > untilMillis) {
          return occurrences;
        }

        if (countLimit !== null && generatedCount >= countLimit) {
          return occurrences;
        }

        generatedCount += 1;

        if (candidateMillis >= windowToMillis) {
          return occurrences;
        }

        const occurrenceEndMillis =
          durationMillis !== null
            ? candidateMillis + durationMillis
            : candidateMillis;

        if (occurrenceEndMillis <= windowFromMillis) continue;

        const originalStart = candidate.toJSDate();
        const exception = exceptionsByOriginalStart.get(candidateMillis);

        if (exception?.isSkipped) continue;

        occurrences.push(
          this.buildOccurrence(
            anchor,
            originalStart,
            durationMillis,
            exception,
          ),
        );

        if (occurrences.length >= MAX_OCCURRENCES_PER_WINDOW) {
          truncated = true;
          break;
        }
      }

      if (truncated) break;

      const next = this.stepPeriod(periodCursor, rule);

      if (next.toMillis() <= periodCursor.toMillis()) break;

      periodCursor = next;
      generationSteps += 1;
    }

    if (truncated) {
      this.logger.warn(
        `expandOccurrences truncated at ${MAX_OCCURRENCES_PER_WINDOW} occurrences for task ${anchor.id} (rule ${rule.id}); window [${windowFrom.toISOString()}, ${windowTo.toISOString()}) is likely too wide`,
      );

      return occurrences;
    }

    // Reaching here without truncating means the loop exited via the
    // independent `MAX_GENERATION_STEPS` backstop rather than a correct
    // window/COUNT/UNTIL termination (those `return` from inside the loop). A
    // far-past anchor can exhaust the step budget before the cursor reaches the
    // window, yielding an empty result — log it so it is never a silent drop.
    if (generationSteps >= MAX_GENERATION_STEPS) {
      this.logger.warn(
        `expandOccurrences hit the ${MAX_GENERATION_STEPS}-step generation backstop for task ${anchor.id} (rule ${rule.id}) before reaching window [${windowFrom.toISOString()}, ${windowTo.toISOString()}); returning ${occurrences.length} occurrence(s) — the anchor's startAt is likely far in the past`,
      );
    }

    return occurrences;
  }

  /**
   * Expands a PROPOSED (not-yet-persisted) recurring series into its concrete
   * occurrences across a bounded look-ahead horizon, for write-side conflict
   * checking (Story 9). Pure and I/O-free: it builds an in-memory anchor + rule
   * from the proposal and reuses {@link expandOccurrences}, so the conflict scan
   * sees exactly the occurrences the series would generate once committed.
   *
   * The scan window runs from the proposed `startAt` to
   * `PREVIEW_SERIES_HORIZON_DAYS` ahead, intersected with the rule's own
   * UNTIL/COUNT termination by the expander. A `NEVER`-ending (effectively
   * infinite) rule is therefore bounded to the horizon — the scan can never hang
   * — and within it the expander's `MAX_OCCURRENCES_PER_WINDOW` cap still holds.
   * A clash that only first arises beyond the horizon is an accepted, documented
   * miss (see {@link PREVIEW_SERIES_HORIZON_DAYS}).
   */
  previewSeriesOccurrences(proposal: ProposedSeries): Occurrence[] {
    // Non-persisted in-memory rule + anchor — `expandOccurrences` reads only
    // these fields and performs no I/O, so the proposal needs no DB round-trip
    // (the method stays pure, like the rest of the expansion engine).
    const rule = {
      id: 'preview-rule',
      frequency: proposal.recurrence.frequency,
      interval: proposal.recurrence.interval ?? 1,
      byWeekday: proposal.recurrence.byWeekday ?? null,
      byMonthDay: proposal.recurrence.byMonthDay ?? null,
      byMonth: proposal.recurrence.byMonth ?? null,
      endType: proposal.recurrence.endType ?? RecurrenceEndType.NEVER,
      endDate: proposal.recurrence.endDate ?? null,
      count: proposal.recurrence.count ?? null,
    } as RecurrenceRule;
    const anchor = {
      id: 'preview',
      title: proposal.title,
      startAt: proposal.startAt,
      endAt: proposal.endAt,
      timezone: proposal.timezone,
      completedAt: null,
    } as Task;

    const windowFrom = proposal.startAt;
    const windowTo = new Date(
      proposal.startAt.getTime() + PREVIEW_SERIES_HORIZON_DAYS * MILLIS_PER_DAY,
    );

    // No exceptions exist for a series that does not yet exist.
    return this.expandOccurrences(anchor, rule, [], windowFrom, windowTo);
  }

  /**
   * Indexes exceptions by the epoch-millis of their `originalStartAt`, so each
   * generated candidate can be matched in O(1) without re-querying.
   */
  private indexExceptions(
    exceptions: TaskOccurrenceException[],
  ): Map<number, TaskOccurrenceException> {
    const index = new Map<number, TaskOccurrenceException>();

    for (const exception of exceptions) {
      index.set(exception.originalStartAt.getTime(), exception);
    }

    return index;
  }

  /**
   * Persists a new RecurrenceRule from a validated DTO and returns the saved row.
   */
  async create(dto: CreateRecurrenceRuleDto): Promise<RecurrenceRule> {
    const rule = this.recurrenceRuleDatabaseService.createInstance({
      frequency: dto.frequency,
      interval: dto.interval ?? 1,
      byWeekday: dto.byWeekday ?? null,
      byMonthDay: dto.byMonthDay ?? null,
      byMonth: dto.byMonth ?? null,
      endType: dto.endType ?? RecurrenceEndType.NEVER,
      endDate: dto.endDate ?? null,
      count: dto.count ?? null,
    });

    return this.recurrenceRuleDatabaseService.save(rule);
  }

  /**
   * Applies a partial update to an existing RecurrenceRule. Mutates only the
   * provided fields and short-circuits when nothing actually changes.
   */
  async update(
    id: string,
    dto: UpdateRecurrenceRuleDto,
  ): Promise<RecurrenceRule> {
    const rule = await this.recurrenceRuleDatabaseService.findOneByOrThrow({
      id,
    });
    let changed = false;

    if (dto.frequency !== undefined && dto.frequency !== rule.frequency) {
      rule.frequency = dto.frequency;
      changed = true;
    }

    if (dto.interval !== undefined && dto.interval !== rule.interval) {
      rule.interval = dto.interval;
      changed = true;
    }

    if (dto.byWeekday !== undefined) {
      rule.byWeekday = dto.byWeekday;
      changed = true;
    }

    if (dto.byMonthDay !== undefined) {
      rule.byMonthDay = dto.byMonthDay;
      changed = true;
    }

    if (dto.byMonth !== undefined) {
      rule.byMonth = dto.byMonth;
      changed = true;
    }

    if (dto.endType !== undefined && dto.endType !== rule.endType) {
      rule.endType = dto.endType;
      changed = true;
    }

    if (dto.endDate !== undefined && dto.endDate !== rule.endDate) {
      rule.endDate = dto.endDate;
      changed = true;
    }

    if (dto.count !== undefined && dto.count !== rule.count) {
      rule.count = dto.count;
      changed = true;
    }

    if (!changed) return rule;

    return this.recurrenceRuleDatabaseService.save(rule);
  }

  /**
   * Deletes a RecurrenceRule by id, throwing when no row matched.
   */
  async remove(id: string): Promise<void> {
    await this.recurrenceRuleDatabaseService.deleteOrThrow(id);
  }
}
