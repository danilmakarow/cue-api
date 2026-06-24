# 0054 — inline-recurrence-and-effective-settings

- **Status**: Accepted
- **Date**: 2026-06-24
- **Deciders**: danil

## Context

Recurrence was a first-class entity: a `recurrence_rule` row referenced by
`task.recurrenceRuleId` and `task_group.defaultRecurrenceRuleId` (both `ON DELETE
SET NULL`). A rule is never shared between anchors (each task/group owns exactly
one), is small (eight scalar fields), and is always read together with its anchor.
The separate table therefore bought nothing — it cost an extra join on every
occurrence read, a CRUD lifecycle (`create` / `update` / `remove`) the feature
services had to orchestrate, and two PG enum types to keep in sync.

Two related capabilities were also missing for the unified Task model:

- A **color** on tasks (groups already had `color`), as either a fixed named
  preset OR a custom `#RRGGBB` hex.
- A **per-task / per-group completion requirement** that resolves with the same
  task-wins-over-group inheritance recurrence already uses, with a sensible
  default when set nowhere.

"Event" is NOT a separate entity — `Task` stays the unified event+todo primitive.

## Decision

Recurrence is stored **inline** as a JSONB `recurrenceConfig` column on each of
`task` and `task_group` (a plain `RecurrenceConfig` POJO mirroring
`CreateRecurrenceRuleDto` field-for-field). The `recurrence_rule` table, both FK
columns, and the two PG enum types are dropped. `RecurrenceFrequency` /
`RecurrenceEndType` survive as standalone enums (moved to
`entities/recurrence-enums.ts`); `RecurrenceConfig` lives in
`recurrence-rule/recurrence.types.ts`.

`RecurrenceRuleService` becomes a **pure expansion engine** with no database
dependency: `expandOccurrences` / `previewSeriesOccurrences` take a
`RecurrenceConfig`, and a static `toConfig(dto)` normalizes a validated DTO into
the stored shape. The CRUD methods and `RecurrenceRuleDatabaseService` /
`RecurrenceRuleRepository` are deleted.

`Task` gains `color varchar null` and `Task` / `TaskGroup` gain a nullable
`requiresCompletion`; `task.requiresCompletion` loses its `NOT NULL DEFAULT true`.
Effective settings resolve **task-wins**: `task value ?? group value ?? default`.
The `requiresCompletion` default of `false` lives in the RESOLVER
(`resolveEffectiveSettings`), never as a column default. `color` is EITHER a
`TaskColor` preset name OR a `#RRGGBB` hex — both accepted and validated at the
DTO and AI-tool boundaries via a single-sourced `isValidTaskColor` predicate.

A new `update_group` AI tool (appended LAST in the registry — ADR-0004
append-only) lets the assistant rename a group and change its inherited defaults;
`create_group` / `create_task` / `update_task` gain `color` / `requiresCompletion`
and may clear (null) recurrence / color / completion-requirement.

## Consequences

- ✅ Occurrence reads drop a join — the config is on the anchor row, fetched by a
  partial index `IDX_task_recurring_anchor … WHERE recurrenceConfig IS NOT NULL`.
- ✅ No recurrence CRUD lifecycle: a split / truncate is a mutate-and-save of the
  inline config; an "add/replace/remove rule" is a column write on the task row.
- ✅ One effective-settings resolver single-sources task-wins inheritance for
  recurrence, completion-requirement, and color.
- ⚠️ **Data loss on migration**: existing `recurrence_rule` rows are NOT migrated
  into JSONB — recurring anchors become one-offs, and their now-orphaned
  `task_occurrence_exception` rows are deleted. Acceptable only because no
  production data exists yet (greenfield); `down()` reverses the schema but cannot
  restore the wiped data.
- ⚠️ Wire-contract drift for cue-ios: the embedded recurrence DTO loses its `id`,
  and task/group DTOs gain `color` / `requiresCompletion` / inline `recurrence`.
- ⚠️ Editing existing AI tool schemas (adding `color` etc.) shifts the cached
  tool-defs prefix once (ADR-0004) — a one-time, harmless cache miss.

## Alternatives considered

### Keep `recurrence_rule` as a table

Loses: pure overhead. The rule is 1:1 with its anchor, never shared, always
co-read — a join and a CRUD lifecycle for no normalization benefit.

### A separate `Event` entity

Loses: contradicts the founding "tasks and events unified" decision; `Task`
already models timed/all-day/todo with optional completion. Splitting would
duplicate recurrence, overrides, and conflict logic across two entities.

### `requiresCompletion` default as a column default

Loses: a column default cannot express task-wins inheritance (a null task value
must fall back to the group, then to `false`). The default has to live where
inheritance is resolved, so it lives in the resolver.

### A dedicated PG enum / CHECK for `color`

Loses: color must accept BOTH named presets AND arbitrary `#RRGGBB` hex. A PG enum
cannot hold open-ended hex values; a CHECK constraint would duplicate the
`isValidTaskColor` predicate in SQL. A plain `varchar` validated at the
application boundary keeps the accepted shape single-sourced.

## References

- [0002 — rrule-not-materialized](0002-rrule-not-materialized.md) — occurrences are
  still never materialized; only the rule's storage changed.
- [0004 — assistant prompt composition and caching](0004-assistant-prompt-composition-and-caching.md)
  (append-only tool order; one-time prefix shift noted above).
- `docs/api/openapi.yaml` — contract drift to reconcile with cue-ios (followup).
