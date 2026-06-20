# 0024 — assistant-recurring-conflict-hold

- **Status**: Accepted
- **Date**: 2026-06-20
- **Deciders**: @danil

## Context

The ADR-0006 held-conflict mechanism ([ai-workflow §9](../specs/ai-workflow.md#9-held-conflict-confirmation-adr-0006-layer-4)) protects against silently booking over existing events: on a timed-write overlap the dispatcher stashes the write, asks the user via an inline keyboard, and executes deterministically on confirm — the model is never re-invoked.

But the hold only runs for **non-recurring** writes. Recurring **creates** are gated behind `handleCreateTask`'s `if (!recurrence && startAt && endAt)` check, and recurring **edits** (`updateRecurring`) never call `findOverlapping` at all. So a **new or edited recurring series can silently book over existing events** — the exact failure the hold exists to prevent, on the write that most often overlaps many days.

Conflict *detection* against existing recurring events is already correct: `findClashingRecurringAnchors` expands by `recurrenceRuleId` and finds the clashing occurrences. The gap is purely that the recurring **write path** doesn't route that detection through the hold. This pre-dates the AI work and was flagged for honesty (Story 9, [ai-workflow §9 "Write-side gap"](../specs/ai-workflow.md#9-held-conflict-confirmation-adr-0006-layer-4)).

[ADR 0018](0018-assistant-ai-comms-phase-b-scope-refinement.md) deferred this from the autonomous wave as safety-relevant multi-write conflict logic; [ADR 0022](0022-deferred-ai-comms-stories-execution-plan.md) authorizes it as **Wave 1** under human review.

The design tension: a recurring series is *one* user intent ("every Tuesday at 14:00") but expands to *many* occupied slots, several of which may clash with different existing events. The ADR-0006 hold mechanism stashes and confirms **one held write**.

## Decision

Recurring **creates and edits** that overlap existing events route through the **same ADR-0006 hold**, as **one held write for the whole series**:

- The clash is detected **occurrence-aware** via `findClashingRecurringAnchors` (the series is expanded and each occurrence checked against existing occupancy), bounded by `MAX_GENERATION_STEPS`.
- The **held action carries the recurrence** — the whole series (the create/edit with its `RecurrenceRule`) is stashed as a single held write, and a single confirm commits the entire series (or a single cancel drops it). One intent → one hold → one keyboard → one confirm.
- For **far-future / effectively-infinite** rules, the occurrence scan is **bounded by `MAX_GENERATION_STEPS`**, and that bound is a **documented limitation**: beyond the generation horizon, conflicts are not guaranteed to be detected. The behaviour at the bound is explicit (safe, documented fallback), never a silent miss inside the scanned horizon.
- Existing **one-off** create/move conflict behaviour is unchanged — this only closes the recurring branch.

## Consequences

- ✅ The recurring write-side gap closes: a new or edited recurring series that overlaps existing events can no longer be booked silently — it holds and asks, exactly like a one-off.
- ✅ **Reuses the existing held mechanism** — no new Redis key, no new callback prefix, no new confirm UX. The recurring case becomes one more held write through the same `confirm:`/`cancel:` path.
- ✅ One held write per series means **one user-facing question** for "every Tuesday clashes with standup," not a barrage — it matches the user's single intent.
- ⚠️ **Documented limitation: far-future / infinite rules are only conflict-checked within `MAX_GENERATION_STEPS`.** A clash beyond the generation horizon is not detected. This is an explicit, bounded trade-off (the alternative — unbounded expansion — is a DoS/perf hazard), recorded so future-us knows it is a deliberate floor, not a bug.
- ⚠️ A single held series-write that commits "all or nothing" means a confirm books every occurrence including any that clash *within* the series' own horizon that the scan flagged; the held prompt must surface *which* occurrences clash so the confirm is informed (it reuses the existing per-action reporting).
- ⚠️ This is safety-relevant multi-write logic touching the held-conflict floor — it is gated by lint + type + jest and reviewed by a human (per ADR 0022 Wave 1), precisely because a regression here could book over existing events.

## Alternatives considered

### Per-occurrence holds (one held write per clashing occurrence)

Rejected — it does **not** fit the ADR-0006 held mechanism, which stashes and confirms one held write. A 52-week series clashing on 30 dates would produce 30 separate holds / 30 keyboards / 30 confirms — unusable UX, and it fractures the user's single "create this series" intent into dozens of unrelated decisions. The one-write-carries-the-recurrence model keeps the series atomic.

### Leave recurring writes unchecked (status quo)

Rejected — that is the silent-book-over bug this ADR exists to fix. Detection (`findClashingRecurringAnchors`) is already correct; not routing it through the hold is the gap.

### Unbounded occurrence expansion for the conflict scan

Rejected — an infinite or far-future rule would expand without limit, a performance/DoS hazard. Bounding by `MAX_GENERATION_STEPS` with a documented limitation is the safe floor; the read-side `check_availability` (Story 7) is the complementary mitigation, not a substitute.

### Re-invoke the model to resolve the recurring clash

Rejected — the held-conflict path is deterministic and never re-invokes the model (the binding ADR-0006 constraint). Recurring clashes stay on the deterministic hold; AI-judged conflicts are a separate v2 decision (Story 15 / ADR 0011), out of scope here.

## References

- The execution plan that authorizes this as Wave 1: [ADR 0022](0022-deferred-ai-comms-stories-execution-plan.md)
- The deferral this closes: [ADR 0018](0018-assistant-ai-comms-phase-b-scope-refinement.md) ("Include Story 9 … Rejected for the autonomous wave")
- The hold mechanism this extends: [ADR 0006](0006-assistant-schedule-context-and-conflicts.md) · [ai-workflow §9](../specs/ai-workflow.md#9-held-conflict-confirmation-adr-0006-layer-4)
- Story 9 acceptance criteria + the `MAX_GENERATION_STEPS` bound: [ai-workflow-tasks Story 9](../specs/ai-workflow-tasks.md) · [recurrence-expansion §conflict-checking](../specs/recurrence-expansion.md#conflict-checking-with-recurrence)
- Complementary read-side mitigation: [ai-workflow-tasks Story 7](../specs/ai-workflow-tasks.md) (`check_availability`)
