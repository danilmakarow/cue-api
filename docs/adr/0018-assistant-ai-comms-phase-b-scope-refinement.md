# 0018 — assistant-ai-comms-phase-b-scope-refinement

- **Status**: Accepted
- **Date**: 2026-06-20
- **Deciders**: @danil

## Context

[ADR 0017](0017-assistant-ai-comms-implementation-scope.md) defined **Phase B = v1 Foundation, Stories 1–9** in a documented suggested order. This refinement is recorded because Phase B's first wave is being executed **autonomously and unattended** — an agent shipping changes without a human in the loop on each step. The original Phase B is a long sequence that mixes well-bounded correctness fixes with large refactors (Story 8 layered decomposition), a new durable DB subsystem (Story 5 `ask_user` + `pending_question`), subtle multi-write conflict logic (Story 9 recurring-conflict hold), and marginal hardening (Story 3b 529 → fallback-model). That mix is appropriate for a human-paced sequence; it is **not** appropriate for one unattended autonomous run, where blast radius must be bounded and every change gated.

There is one **confirmed §13 production bug**: the model narrates a batch action and writes nothing ([ai-workflow §13](../specs/ai-workflow.md#13-known-failure-mode-today--narration-without-writing)). The three loop-correctness items that fix it are small, gated, and high-value; the rest of Phase B is larger, riskier, or marginal.

A partial earlier run also touched the BullMQ queue posture — see Consequences.

## Decision

**Autonomous Phase B ships only the loop-correctness trio**, then stops for human review:

- **Story 3a — neutral `AiToolChoice` on the connector** (the connector half of Story 3; recorded separately as [ADR 0019](0019-assistant-neutral-ai-tool-choice.md)).
- **Story 1 — narration re-drive + escalation sink** ([ADR 0009](0009-assistant-narration-redrive.md)).
- **Story 2 — batch `create_tasks` tool**.

These three together fix the confirmed §13 bug: 3a gives the loop the forced-tool-call primitive, Story 1 re-drives a narration-without-write turn, Story 2 makes the re-driven "create N" call trivially correct.

**Everything else in Phase B is DEFERRED to explicit human review** — no autonomous run starts any of them:

- **Story 3b** — 529 → fallback-model swap (marginal at personal scale; see below).
- **Story 4** — `buildTool` contract + single-source Zod migration (large correctness-neutral churn over 9 working handlers).
- **Story 5** — `ask_user` durable suspend/resume (a **new DB subsystem**: entity, migration, Redis hot index, compare-and-set).
- **Story 6** — inbound 4-flow router + turn-runner convergence (only meaningful once Story 5 exists).
- **Story 7** — `check_availability` batch read tool (depends on Story 4 registry).
- **Story 8** — layered decomposition (the largest refactor; the god-service lift).
- **Story 9** — write-side recurring-conflict hold (subtle multi-write conflict logic; safety-relevant).

This **refines** ADR 0017's "Phase B = Stories 1–9" — it does not supersede it. ADR 0017's order, gates, and per-story ADR discipline still hold; this ADR only narrows *what an unattended autonomous run is permitted to ship in this wave* and bumps Story 3 first because its connector half (3a) is the trio's prerequisite.

## Consequences

- ✅ The unattended run ships a **well-bounded, gated, high-value** change set: the three items that fix the one confirmed production bug, each gated by lint + type + jest (per ADR 0017) and each correctness-focused.
- ✅ Large refactors (Story 8), a new durable DB subsystem (Story 5), subtle multi-write conflict logic (Story 9), and marginal items (3b, 4, 6, 7) wait for a human — exactly the classes of change that should not land unattended.
- ⚠️ **BullMQ `defaultJobOptions` is now `attempts: 1`** (global). A partial earlier run had set it to `5`; that was **reverted as a double-write hazard** — at `attempts > 1` a thrown turn replays and re-creates tasks (the §6 / ADR 0009 "every terminal path returns, never throws" invariant exists precisely because the queue is `attempts: 1`). **Carry-forward:** when the **`assistant-background` queue** is registered it will **inherit `attempts: 1`** from the global default. If its jobs are idempotent and *should* retry, give that queue a **per-queue `attempts` override** at `registerQueue` time rather than raising the global default (which would re-introduce the replay hazard on the inbound webhook queue and force every terminal path to become an `UnrecoverableError`).
- ⚠️ The §13 fix lands without the 529 fallback (3b), so a sustained main-model overload during a re-drive still degrades to the honest terminal-error reply rather than a Haiku fallback. Accepted — see the 529 reasoning below.
- ⚠️ The deferral list is long; picking it back up needs a human to re-confirm ADR 0017's order still holds (soft dependencies: 6 wants 5, 7 wants 4, 8 hosts 1–7).

### On 529 → fallback (Story 3b) being marginal — the honest reasoning

3b is deferred not merely because it is "next" but because at **personal scale it is marginal**:

- Today's `AI_FAILURE_REPLY` degradation on sustained overload is **acceptable** for a single-user personal assistant — a rare "try again in a moment" is a fine outcome, not a dropped obligation.
- The fallback's own cost: swapping the **main** turn to **Haiku** under load risks **worse decisions** (a wrong write is worse than a deferred one), so the fallback is not strictly an improvement.
- **Revisit if** production logs show **real post-retry 529s** (i.e. the SDK's existing backoff/retry is genuinely exhausting on overload, not just transient). Until the data says otherwise, the SDK's built-in retry (`ASSISTANT_AI_MAX_RETRIES`) is the floor and the fallback is not worth the added decision-quality risk.

## Alternatives considered

### Run all of Phase B (Stories 1–9) autonomously, per ADR 0017's order

Rejected — ADR 0017's sequence was scoped for human-paced work with a review checkpoint per story. Unattended, it would land a god-service refactor (8), a new durable subsystem with a migration (5), and safety-relevant conflict logic (9) with no human gate — far past the blast radius an autonomous run should own.

### Ship only Story 1 (the bug fix) and nothing else

Rejected as too narrow — Story 1 is **blocked by** the connector's `AiToolChoice` (3a), and pairs naturally with Story 2 (the batch tool is what makes the re-driven "create N" call correct). The trio is the minimal *complete* fix for §13; shipping 1 alone leaves it non-functional or fragile.

### Include Story 3b (529 fallback) in the autonomous wave

Rejected for this wave — marginal value at personal scale, and the Haiku-on-main risk means it is not a clear win. Folded into the deferred set with an explicit revisit trigger (real post-retry 529s in logs).

### Include Story 9 (recurring-conflict hold) — it is "a standalone correctness fix"

Rejected for the autonomous wave — it is correctness-relevant but **safety-relevant multi-write conflict logic** touching the held-conflict floor; a silent regression could book over existing events. Exactly the kind of change that wants a human reviewing the conflict cases, not an unattended run.

## References

- The phase plan this refines: [ADR 0017](0017-assistant-ai-comms-implementation-scope.md)
- The §13 bug the trio fixes: [ai-workflow §13](../specs/ai-workflow.md#13-known-failure-mode-today--narration-without-writing)
- Trio decisions: [ADR 0009](0009-assistant-narration-redrive.md) (Story 1) · [ADR 0019](0019-assistant-neutral-ai-tool-choice.md) (Story 3a `AiToolChoice`)
- The backlog: [ai-workflow-tasks](../specs/ai-workflow-tasks.md) (Stories 1, 2, 3; deferred 3b/4/5/6/7/8/9)
- The `attempts:1` invariant: [ai-workflow §11](../specs/ai-workflow.md#11-retries--resilience--every-layer) · [ADR 0009](0009-assistant-narration-redrive.md) Consequences
