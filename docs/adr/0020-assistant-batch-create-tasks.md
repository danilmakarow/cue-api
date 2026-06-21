# 0020 — assistant-batch-create-tasks

- **Status**: Accepted
- **Date**: 2026-06-20
- **Deciders**: @danil

## Context

There is **no batch create** today — making N tasks requires N separate `create_task` calls ([ai-workflow §7.1](../specs/ai-workflow.md#71-tool-inventory-toolstool-schemasts)). That plural case is exactly the cognitive load that tips the model into narrating a prose plan instead of emitting N tool calls — the confirmed §13 failure mode the narration re-drive ([ADR 0009](0009-assistant-narration-redrive.md), Story 1) fixes. A batch tool makes the re-driven call **trivially correct** ("create all seven" → one call) and cuts per-turn tokens. This is **Story 2** of the Phase-B loop-correctness trio (3a → 1 → 2, [ADR 0018](0018-assistant-ai-comms-phase-b-scope-refinement.md)); deep design in [assistant-tool-loop-redrive §Batch](../specs/assistant-tool-loop-redrive.md).

Three forces shape the decision:

- A batch must not regress the deterministic held-conflict contract ([ADR 0006](0006-assistant-schedule-context-and-conflicts.md) layer 4): a conflicting item is **held and confirmed with the user**, never re-planned by the model, and a silent double-booking stays impossible.
- One conflicting item must not lose the non-conflicting ones — a whole-batch abort would punish the user for a single clash and re-introduce the very narration/re-ask churn we are removing.
- Adding the tool must not break the ADR-0004 cache prefix: the tool schemas sit in breakpoint #1, shared byte-identically across all users, so **tool order is load-bearing**.

## Decision

Add a batch **`create_tasks`** write tool that fans out to `TaskService.create` **in input order**, capped at **25 items** via `z.array(createTaskInputSchema).min(1).max(25)` (over-cap returns a recoverable `tool_result` asking the model to split — not a crash).

Per-item conflict-checking **reuses the existing ADR-0006 held mechanism** — it does **not** build a new one. Conflicting items are collected as **held writes** and confirmed together via the **existing inline-keyboard batch-hold path** ([ai-workflow §9](../specs/ai-workflow.md#9-held-conflict-confirmation-adr-0006-layer-4)). There is **no whole-batch abort**: non-conflicting items commit, conflicting items are held, and the held set is confirmed after the round. To support per-item accounting and plural holds:

- **`ToolDispatchOutcome` gains optional plural fields** — `heldConflicts?` (plural, beside the existing singular held shape) and `committed` / `attempted` counts. Non-batch tools leave them unset.
- **`runToolLoop`'s write accounting** increments `committedWrites` / `attemptedWrites` by the **per-call counts** when present, **falling back to the singular `+1`** for non-batch tools. So "5 of 7 committed, 2 held" is counted correctly, and `committedWrites > 0` keeps the turn on the `genuine` terminal branch ([ADR 0009](0009-assistant-narration-redrive.md)) rather than re-driving.
- **`create_tasks` joins `WRITE_TOOLS`**, so each committed item counts toward the saved-changes report and the success-integrity guard ([ai-workflow §10](../specs/ai-workflow.md#10-success-integrity-guard-the-trick-that-catches-lies)).
- **The tool schema is appended last** in `tools/tool-schemas.ts`, never inserted mid-list, to preserve tool-order / cache-breakpoint #1 stability ([ADR 0004](0004-assistant-prompt-composition-and-caching.md)). The prefix re-baselines **once** when the tool lands, then stays byte-stable.

Scope is **create only** — no batch update/delete/complete.

## Consequences

- ✅ "Create these seven" becomes **one** tool call — the re-driven write is trivially correct, and the narration temptation (§13) is structurally reduced, not just detected.
- ✅ A single clashing item no longer aborts the batch: the rest commit, the conflict is held and confirmed with the user — correctness ([ADR 0006](0006-assistant-schedule-context-and-conflicts.md)) preserved with **no extra LLM call**.
- ✅ No new conflict subsystem and no new confirmation UX — the held path and inline keyboard are reused verbatim; less code, one source of truth for "held → confirm".
- ✅ Per-call write accounting makes partial outcomes ("5 of 7") honest in both the report and the guard, and keeps a partially-committing turn on the `genuine` branch (no spurious re-drive).
- ✅ Appending the schema keeps the ADR-0004 shared cache prefix warm after a single re-baseline.
- ⚠️ `ToolDispatchOutcome` now carries optional plural fields the singular tools ignore — a small shape asymmetry until Story 4's registry normalizes tool I/O.
- ⚠️ A mixed batch can produce a **multi-item held set** to confirm at once; the batch-hold keyboard must render N held items legibly (bounded by the 25-cap).
- ⚠️ The 25-item cap is a product guess; a genuinely larger batch is bounced back to the model to split (recoverable, not fatal). Tunable per metrics.
- ⚠️ Fan-out is **serial, in input order** (matching the dispatcher's serial in-emission-order contract), so a 25-item batch is 25 sequential `TaskService.create` calls within the turn — acceptable at personal scale.

## Alternatives considered

### Whole-batch abort on the first conflict

Reject the entire `create_tasks` call (or roll it back) if any item clashes, and hand the conflict back. Rejected — it punishes the user for one clash, drops work they clearly wanted, and re-introduces the re-ask/narration churn Story 2 exists to remove. Holding only the conflicting items while the rest commit is strictly better and still deterministic.

### A new batch-specific held mechanism

Build a parallel "batch hold" store/keyboard distinct from the ADR-0006 single-write hold. Rejected — it duplicates the Redis-TTL hold, the `confirm:` / `cancel:` callback wiring, and the inline keyboard, doubling the surface that must stay correct and disjoint from `ask_user` ([ADR 0010](0010-assistant-ask-user-stateful-resume.md)). The existing held mechanism already represents "writes pending user confirmation"; a batch is just **more than one** held write through the same path.

### Return conflicts to the model to re-plan the batch

The "agentic" variant — return the clashing items and let the model propose new slots. Rejected for the same reason as [ADR 0006](0006-assistant-schedule-context-and-conflicts.md): an extra Sonnet round-trip per conflict, nondeterministic (the model may propose another clash), slower and pricier than asking the user. Conflict resolution stays deterministic and human-in-the-loop.

### Insert the new schema in tool-name order (alphabetical / grouped near `create_task`)

Tidier to read. Rejected — any reorder of the tool block shifts bytes inside ADR-0004 cache breakpoint #1, cold-starting the **shared, multi-tenant** prefix for every user. Appending last re-baselines the prefix exactly once. Reading tidiness is not worth a cache-wide invalidation.

### Batch tool, no re-drive (or re-drive, no batch tool)

Rejected as either-or — the batch tool **reduces** narration but the model can still narrate even a single batch call; the re-drive **eliminates** it but leaves N-call batches expensive and fragile. They are necessary-but-insufficient apart; the trio ships both ([ADR 0018](0018-assistant-ai-comms-phase-b-scope-refinement.md)).

## References

- The bug this completes the fix for + deep batch design: [assistant-tool-loop-redrive](../specs/assistant-tool-loop-redrive.md) · Story 2 (shipped) as-built: [ai-workflow](../specs/ai-workflow.md)
- Held-conflict mechanism reused (no new one): [ADR 0006](0006-assistant-schedule-context-and-conflicts.md)
- Narration re-drive this pairs with (write accounting / `genuine` branch): [ADR 0009](0009-assistant-narration-redrive.md)
- Cache-prefix / tool-order constraint (append last): [ADR 0004](0004-assistant-prompt-composition-and-caching.md)
- Phase-B trio scope (3a → 1 → 2): [ADR 0018](0018-assistant-ai-comms-phase-b-scope-refinement.md)
- Current tool inventory + write accounting: [ai-workflow §6](../specs/ai-workflow.md#6-the-tool-use-loop--the-heart-runtoolloop), [§7.1](../specs/ai-workflow.md#71-tool-inventory-toolstool-schemasts)
