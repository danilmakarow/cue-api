# 0029 — assistant-check-availability-batch-read

- **Status**: Accepted
- **Date**: 2026-06-20
- **Deciders**: @danil

## Context

The assistant can answer "where are the gaps" (`find_free_slots`) but it **cannot answer "are *these* 10 slots free"** in one call. The only true conflict primitive in the codebase — `TaskService.findOverlapping` — is reachable today **solely as a write side-effect**: it fires inside the ADR-0006 hold when a `create_task`/move lands on an existing event. There is no read-side way to ask it a question.

That gap bites exactly the batch case. To validate 10 proposed times the model must currently probe one date per round, and the per-turn schedule-fetch budget is `ASSISTANT_MAX_SCHEDULE_FETCHES = 5` ([ai-workflow §3 / §7.1](../specs/ai-workflow.md#71-tool-inventory-toolstool-schemasts)). Ten proposals therefore **cannot** be validated under the cap, and even a partial probe leans on the model remembering to look. Worse, the obvious shortcuts are silently wrong:

- Reading raw `task` rows (or `findInRange`) **misses recurring occupancy** — the 5th occurrence of a series whose master row is weeks earlier does not appear as a row in the window, so a "free" verdict would be a lie. Only `findOverlapping` → `findClashingRecurringAnchors` expands recurring anchors into the probed window.
- Unioning the slots into **one** `[min(startAt), max(endAt)]` window over-reports: a conflict anywhere in the span marks unrelated free slots busy.

This is **Story 7 / Wave 3** of the deferred-stories execution plan ([ADR 0022](0022-deferred-ai-comms-stories-execution-plan.md)). It depends on **Story 4 / Wave 2** ([ADR 0025](0025-assistant-buildtool-single-source-registry.md)): the `buildTool` registry is what lets this tool **classify itself** read/schedule-fetch through `registry.readNames()` instead of being hand-added to a `Set`. It is the **read-side** complement to Story 9's write-side hold fix ([ADR 0024](0024-assistant-recurring-conflict-hold.md)) — neither replaces the other.

## Decision

We add `check_availability` — a **read / schedule-fetch** tool, **never** a write — that validates a batch of proposed slots in **one** model-visible call.

```
check_availability({
  slots: { startAt, endAt, calendarId?, excludeTaskId? }[].min(1).max(25)
})
→ per slot { index, free, conflicts: { handle, title, occurrenceStart, occurrenceEnd }[] }
```

Non-negotiable correctness contract:

- **One `findOverlapping` call per slot, with that slot's *exact* bounds.** This is the **same source the write-time hold trusts**, so a "free" verdict from `check_availability` and a later `create_task` on that slot **can never disagree**. The tool is a read-only pre-flight of the exact check the write path will re-run.
- **It never reads raw `task` rows / `findInRange`** (those miss recurring occupancy) and **never unions the slots into one window** (that over-reports). One slot in, one `findOverlapping` out — N times.
- **Conflicts mint `[eN]` handles** via the per-turn `HandleMap` (the same `alias → { taskId, occurrenceStart }` map seeded by the context builder and appended by `list_tasks`), so the model can move/skip a conflicting event immediately by handle in the same turn.
- **One batch call counts as exactly ONE** of the five schedule-fetches — that is the entire point versus probing.
- **A recurring *proposal*** (a slot that is itself an RRULE, not a single window) is **either rejected honestly or self-expanded per occurrence (bounded)** and each occurrence checked — it is **never silently validated as one window**, because a single `findOverlapping` tests one window and would pass a rule that clashes on its 3rd occurrence. The expansion shares Story 9's bounded-expansion helper and is capped by `MAX_GENERATION_STEPS`.

It is authored as a `buildTool` definition in the Story-4 registry ([ADR 0025](0025-assistant-buildtool-single-source-registry.md)), classified **`isScheduleFetch = true`, `isWrite = false`** — so write accounting, the saved-count, and the success-integrity guard correctly ignore it, and the schedule-fetch cap correctly counts it.

The flow it unlocks: `check_availability([10])` → all free → `create_tasks([free])` → report; some busy → `ask_user` with the conflicting `[eN]` handles as options ("skip / pick another / overwrite"), or let the single-slot ADR-0006 hold take over. A "create 10, checking availability" turn collapses to **two rounds, one fetch**.

## Consequences

- ✅ **A "free" verdict is trustworthy** — it is the *identical* `findOverlapping` the write path runs, including recurring occupancy, so the read pre-flight and the eventual write never disagree.
- ✅ **Batch validation fits the budget** — 10 (or 25) proposals cost **one** of five fetches instead of being impossible; the model gathers in one call and acts in one turn.
- ✅ **Conflicts are immediately actionable** — `[eN]` handles let the model reroute the clashing event without a second lookup round.
- ✅ **Recurrence-correct by construction** — per-slot exact-bounds checks (never raw rows, never a union window) catch recurring occupancy that a row read would miss.
- ✅ **Self-classifying via the registry** — read/schedule-fetch falls out of `registry.readNames()`; no hand-maintained `Set` to forget.
- ⚠️ **The recurring-proposal path is the subtle one.** It must expand-and-check (bounded), not single-window; getting this wrong silently re-introduces the exact over-trust the tool exists to prevent. It is the explicit risk and shares Story 9's helper to avoid a second, divergent expansion.
- ⚠️ **Read-side only — not a guarantee.** `check_availability` pre-empts most conflicts but does **not** close the write-side hold gaps (recurring creates/edits — Story 9 / [ADR 0024](0024-assistant-recurring-conflict-hold.md)); the hold stays the **authoritative floor**. Its verdict is "no conflict found in window", and a far-past anchor exhausting `MAX_GENERATION_STEPS` is the same documented caveat as the write path.
- ⚠️ **N overlap queries per call.** Up to 25 `findOverlapping` calls per batch (each possibly expanding recurring anchors); bounded by `.max(25)` and acceptable for the token/round-trip it saves, but it is real per-call DB work, not free.

## Alternatives considered

### Read raw `task` rows / reuse `findInRange` for the batch

The cheap "just SELECT the rows in the window and diff" approach. Rejected — it **misses recurring occupancy**: a recurring series whose master row sits weeks before the probed window contributes no row inside it, so an occupied slot reads as free. Only `findOverlapping` (→ `findClashingRecurringAnchors`) expands recurring anchors into the probed window. A tool whose "free" can be a lie is worse than no tool.

### Union the slots into one window and check once

One `findOverlapping` over `[min(startAt), max(endAt)]`. Rejected — it **over-reports**: a single conflict anywhere in the span marks every other (genuinely free) slot busy, and it cannot attribute a conflict to a specific slot index. The per-slot, exact-bounds loop is the only shape that yields a correct per-slot verdict.

### Make it a write tool (validate as a dry-run of the hold)

Routing the proposals through a write path with a "don't commit" flag. Rejected — it conflates the read pre-flight with the write floor, breaks write accounting / the saved-count / the success-integrity guard (all keyed on `WRITE_TOOLS`), and would have the tool count against write semantics it does not perform. `check_availability` is deliberately **`isWrite = false`**; the authoritative write-time check stays in the ADR-0006 hold, which `check_availability` merely **pre-runs read-only with the same primitive**.

### Validate a recurring proposal as one window

Treating a proposed *rule* as a single `[startAt, endAt]`. Rejected — a single `findOverlapping` tests one window, so a rule that is free on its first occurrence but clashes on its third would pass. A recurring proposal must be **expanded per occurrence (bounded by `MAX_GENERATION_STEPS`) or rejected honestly** — never silently validated as one window.

## References

- Story 7 (shipped) as-built: [ai-workflow](../specs/ai-workflow.md)
- Deep design — *Lookups & proactive availability* (correctness contract, recurrence verification): [assistant-layered-architecture §lookups](../specs/assistant-layered-architecture.md#lookups--proactive-availability--check_availability-recurrence-aware)
- The `buildTool` registry that classifies it read/schedule-fetch (dependency, Wave 2): [ADR 0025](0025-assistant-buildtool-single-source-registry.md)
- The deterministic hold whose primitive (`findOverlapping`) this read-pre-flights — and which stays the authoritative floor: [ADR 0006](0006-assistant-schedule-context-and-conflicts.md)
- The write-side recurring-conflict fix this complements (shared bounded-expansion helper): [ADR 0024](0024-assistant-recurring-conflict-hold.md)
- The wave plan placing this at Wave 3, after the registry: [ADR 0022](0022-deferred-ai-comms-stories-execution-plan.md)
- Current tool inventory + the schedule-fetch budget it spends: [ai-workflow §7.1](../specs/ai-workflow.md#71-tool-inventory-toolstool-schemasts)
