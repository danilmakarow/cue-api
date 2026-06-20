# 0022 — deferred-ai-comms-stories-execution-plan

- **Status**: Accepted
- **Date**: 2026-06-20
- **Deciders**: @danil

## Context

[ADR 0018](0018-assistant-ai-comms-phase-b-scope-refinement.md) shipped the autonomous Phase-B wave — the loop-correctness trio (Story 3a `AiToolChoice` → Story 1 narration re-drive → Story 2 batch `create_tasks`) that fixes the one confirmed §13 production bug — and **deferred everything else (Stories 3b, 4, 5, 6, 7, 8, 9) to explicit human review**. That deferral was the right posture for an *unattended* run: large refactors, a new durable DB subsystem, and safety-relevant multi-write conflict logic should not land without a human gate.

The user has now **authorized implementing the deferred stories** under human review. This is the missing piece ADR 0018 explicitly required — "picking it back up needs a human to re-confirm ADR 0017's order still holds." This ADR records that authorization, the build order, and the dependency + risk rationale for that order, so the remaining work is sequenced rather than picked at random.

The deferred set is not a flat list — it has real dependencies (the [ai-workflow-tasks](../specs/ai-workflow-tasks.md) "Depends on" column) and a spread of risk (a marginal connector tweak at one end, a god-service refactor and safety-relevant conflict logic at the other). Ordering must respect both.

## Decision

We implement the deferred AI-comms stories under human review, in **six waves**, each gated by **lint + type + jest** and each carrying **its own ADR** (per ADR 0017's per-story discipline):

| Wave | Story | What it ships | Hard dependency | ADR |
|---|---|---|---|---|
| **1** | **3b — 529 → fallback model** | survive sustained main-model overload | — | [0023](0023-assistant-529-fallback-model.md) |
| **1** | **9 — recurring-conflict hold** | recurring create/edit routes through the ADR-0006 hold | — | [0024](0024-assistant-recurring-conflict-hold.md) |
| **2** | **4 — `buildTool` single-source registry** | one descriptor per tool; no JSON↔Zod drift | — | TBD (Story 4) |
| **3** | **7 — `check_availability`** | batch read-side slot validation | **Story 4** (registry classification) | TBD (Story 7) |
| **4** | **6 — inbound 4-flow router + turn-runner** | one router + one convergence point | — (but pairs with 5) | TBD (Story 6) |
| **5** | **5 — `ask_user` durable suspend/resume** | ask-a-question-and-resume | **Story 6** (routes the answer) | [0010](0010-assistant-ask-user-stateful-resume.md) |
| **6** | **8 — layered decomposition** | structural home for 1–7 | hosts 1–7 | TBD (Story 8) |

**Wave 1 (3b + 9) runs in parallel** — both are standalone, dependency-free, high-value correctness/resilience fixes that touch disjoint code (3b is connector transport; 9 is the dispatcher write path). They are the two items ADR 0018 deferred purely because they were *unattended-unsafe*, not because they were blocked.

**Waves 2→6 are strictly serial on their dependencies:** 7 needs 4's registry classification; 5 needs 6 to route the typed-answer flow; 8 is the god-service lift that *hosts* the earlier stories as behaviour-preserving migration steps, so it goes last (every earlier story has already proven itself in the existing structure, lowering the lift's blast radius).

This **supersedes [ADR 0018](0018-assistant-ai-comms-phase-b-scope-refinement.md)'s deferral** of these stories (the deferral is now lifted, with this ordering). It does **not** supersede ADR 0018's autonomous-wave decision (the trio still shipped as recorded) nor [ADR 0017](0017-assistant-ai-comms-implementation-scope.md)'s phase plan, gates, or per-story-ADR discipline, all of which this ADR upholds.

## Consequences

- ✅ The deferred work has a **defined, dependency-respecting order** with a per-wave quality gate and a per-story ADR — no more "which one next?" ambiguity, and each wave is independently reviewable.
- ✅ Wave 1 lands **two independent correctness/resilience wins immediately and in parallel** (529 survival + the recurring-conflict safety gap), neither blocked by the heavier refactors.
- ✅ The two genuinely risky changes are **isolated and late-ish**: Story 9's safety-relevant conflict logic is its own gated wave (with a dedicated ADR), and Story 8's god-service lift goes last, after every story it hosts is already proven in the current structure.
- ⚠️ Story 8 (the layered decomposition) is the **largest single change** and remains the highest-risk wave even with everything proven beforehand — the loop-lift keystone step must be a byte-identical move first, behaviour changes after.
- ⚠️ The chain 4 → 7 and 6 → 5 means a slip in an early wave **delays its dependents**; the parallel Wave 1 and the independent Story 4 partly hedge this.
- ⚠️ Six waves is a long runway; **each is human-gated**, so total calendar time is bounded by review availability, not just implementation.

## Alternatives considered

### Keep ADR 0018's deferral and ship nothing more

Rejected — the user has explicitly authorized the work. ADR 0018's deferral was conditioned on "explicit human review," which is now present; holding the line would ignore that condition.

### Implement strictly in story-number order (3b → 4 → 5 → 6 → 7 → 8 → 9)

Rejected — it ignores the real dependencies. Story 5 (`ask_user`) depends on Story 6's router to deliver the typed answer, so 5-before-6 would build a durable store with no flow to route into it. Story 7 depends on Story 4's registry. Number order also leaves Story 9 (a dependency-free safety fix) until last for no reason.

### One big wave (land everything, gate once at the end)

Rejected — it reproduces exactly the unattended-blast-radius problem ADR 0018 guarded against, only with a human watching the wreckage. Per-wave lint+type+jest gates and per-story ADRs keep each change reviewable and bisectable.

### Do Story 8 (layered decomposition) first, then land 1–7 inside it

Rejected — the layered move is the largest, riskiest change, and doing it first means the keystone loop-lift happens before any of the stories it hosts are proven. Landing 4/5/6/7 in the current structure first means Story 8 becomes a series of behaviour-preserving lifts of *already-working* code, not a rewrite-and-pray.

## References

- The wave the trio shipped in, and the deferral this lifts: [ADR 0018](0018-assistant-ai-comms-phase-b-scope-refinement.md)
- The phase plan and per-story-ADR discipline this upholds: [ADR 0017](0017-assistant-ai-comms-implementation-scope.md)
- Wave 1 decisions: [ADR 0023](0023-assistant-529-fallback-model.md) (Story 3b) · [ADR 0024](0024-assistant-recurring-conflict-hold.md) (Story 9)
- Story 5 decision (Wave 5): [ADR 0010](0010-assistant-ask-user-stateful-resume.md)
- The backlog with per-story acceptance criteria + dependencies: [ai-workflow-tasks](../specs/ai-workflow-tasks.md)
- Current state: [ai-workflow](../specs/ai-workflow.md)
