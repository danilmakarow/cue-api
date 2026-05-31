# 0002 — rrule-not-materialized

- **Status**: Accepted
- **Date**: 2026-05-31
- **Deciders**: @danil

## Context

A recurring task ("every weekday at 9am", "first Monday of every month") can be modeled two ways:

1. **Materialized**: on creation/edit, expand the rule into N concrete `Task` rows (or `TaskOccurrence` rows) for the next M months. Each row is independent.
2. **Rule + exceptions**: store one `Task` plus a `RecurrenceRule` describing the repeat pattern. Generate occurrences on demand. Store divergences (skips, time shifts, completions) as `TaskOccurrenceException` rows keyed by `(taskId, originalStartAt)`.

This is the RFC 5545 / iCalendar pattern (`RRULE` + `EXDATE` + `RECURRENCE-ID`).

## Decision

We model recurrence as **one `Task` + one `RecurrenceRule` + zero-or-more `TaskOccurrenceException` rows**. Occurrences are computed on-demand from the rule; only divergences are persisted.

## Consequences

- ✅ Editing the series ("change time of all future occurrences") is a single-row update.
- ✅ Indefinite recurrences ("forever, every Monday") work without a sliding materialization window.
- ✅ Time-zone correctness lives in one place (the rule's `timezone` + Luxon expansion), not duplicated across rows.
- ✅ Storage is O(divergences), not O(occurrences).
- ⚠️ Every read of "what's on my calendar between dates A and B" must expand the rule. Mitigated by:
  - Expansion is cheap (RRULE libraries handle 1k-occurrence windows in <10ms).
  - The materialized output for *notification delivery* lives in `ScheduledNotification` — see [specs/notification-delivery.md](../specs/notification-delivery.md).
- ⚠️ Per-instance fields (completion, override notes) require a separate `TaskOccurrenceException` table with `(taskId, originalStartAt)` lookup.

## Alternatives considered

### Materialize occurrences as concrete rows

Simple reads (no expansion), simple per-instance edits. Rejected because:

- "Edit all future occurrences" becomes a multi-row update with conflict risk.
- Indefinite recurrences require a periodic "extend the window" job.
- Time-zone changes (user moves countries, DST transitions) force re-materialization of every affected row.

### Materialize only the next N occurrences ("rolling window")

Hybrid of the two. Rejected because we'd own *both* the rule-expansion code path *and* the materialization-window cron, with extra complexity at their seam (what happens when the rule changes mid-window?).

## References

- RFC 5545 — Internet Calendaring and Scheduling Core Object Specification
- Entity: `src/modules/database/entities/recurrence-rule.entity.ts`
- Per-instance overrides: `src/modules/database/entities/task-occurrence-exception.entity.ts`
- Notification fan-out: [specs/notification-delivery.md](../specs/notification-delivery.md)
