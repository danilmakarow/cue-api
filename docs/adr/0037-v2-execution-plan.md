# 0037 — v2-execution-plan

- **Status**: Accepted
- **Date**: 2026-06-21
- **Deciders**: @danil

## Context

v1 of the Telegram AI assistant is shipped and committed — Stories 1–9 (loop correctness, `ask_user`, batch tools, connector hardening) plus the Story 8 layered decomposition that landed the clean **L0–L11** model (baseline `85fb290` + the turn-runner convergence `ebd5ae3`, [ADR 0036](0036-assistant-turn-runner-convergence.md)). v2 (Stories 10–18 — live status message, native streaming, message debounce/coalescing + STOP, AI-judged conflicts, reply-keyboard navigation, daily reports, per-user personality) builds **additively** on those layers.

Until now the v2 plan was spread across two planning docs — a research dossier (`ai-workflow-v2-research.md`, verified Telegram facts) and the backlog's v2 section (`ai-workflow-tasks.md`, Stories 10–18). The per-story ADRs (0011–0015) were written but no single doc recorded the **order of work**, the **gate discipline**, and — critically — four **corrected assumptions** that diverge from the original research/backlog framing, including a story that supersedes an already-accepted ADR. We need one authoritative forward plan and one decision record fixing its order and corrections, so v2 proceeds predictably rather than re-litigating settled points.

## Decision

**We adopt a single authoritative forward plan ([ai-workflow-v2-plan](../specs/ai-workflow-v2-plan.md)) with a five-wave order and four binding corrected assumptions; the two prior planning docs are retired (folded into the plan).**

**Wave order** — one ADR per wave, every change gated by `pnpm run lint` + `pnpm run type` + `pnpm jest`, e2e at each wave's end:

- **Wave A (foundation, parallel):** Story 10 (messenger primitives + `StatusSession`, L9) + Story 11 (per-user serialization lock, L3) — dependency-free, disjoint code.
- **Wave B (status/streaming core):** Story 12 (live status message; needs 10) → Story 13 (native streaming + per-step recaps; needs 10, 12).
- **Wave C (message-flow control):** Story 14 (debounce + combine + queue-after + STOP; needs 10, 11) — **highest behavioural risk**; isolated in its own wave.
- **Wave D (conflict reversal):** Story 15 (AI-judged conflicts) — **safety-critical**; deletes the L8 deterministic hold; landed alone.
- **Wave E (independent add-ons):** Story 16 (reply-keyboard + ASCII calendar; needs 10), Story 18 (per-user personality; independent), Story 17 (per-day reports) — 17 trails behind its delivery-worker prerequisite.

**Four corrected assumptions** (binding):

1. **Story 18 — the "tool defs billed full price every turn" cache bug is a MISDIAGNOSIS; its cache-bug AC is DROPPED.** Tools precede `system` in Anthropic's prefix order, so they are **already cached by breakpoint #1**; they need no own boundary. Fix/delete the false comment + dead `ToolSchema.cacheBoundary` path; **do not** wire a redundant tools `cacheBoundary`. ([ADR 0016 A4](0016-assistant-ai-comms-audit-hardening.md) · [ai-comms audit §A4/§B](../specs/ai-comms-cc-audit.md).)
2. **Story 15 SUPERSEDES ADR-0006 layer 4** (the deterministic conflict hold + the `confirm:`/`cancel:` `HeldConflictBatch` path). It moves a deterministic double-book guard to model judgement — **safety-critical**. Merge gate = strict default-deny in **both** the system prompt and **every** conflict tool-result + the dispatcher returning the overlap as a recoverable `isError` tool_result. Already framed by [ADR 0011](0011-assistant-ai-judged-conflicts.md); depends on v1 Story 5 `ask_user` (shipped).
3. **Story 17 is BLOCKED on a `ScheduledNotification` delivery worker that does not yet exist** ([notification-delivery](../specs/notification-delivery.md) is Draft). Sequence the worker first, or send directly through the Telegram connector as an interim — stated as the gating prerequisite.
4. **The draft-call throttle is UNDOCUMENTED** — cap all draft calls conservatively at ~2–5/s, centrally in the L9 egress layer (mandatory).

## Consequences

- ✅ One canonical forward plan; the order of work, the gate discipline, and the corrected assumptions live in one place instead of being re-derived per story.
- ✅ The two highest-risk stories are isolated by wave (14 behavioural, 15 safety), each behind its own ADR with an explicit merge gate.
- ✅ Dropping the Story 18 cache AC avoids a redundant tools `cacheBoundary` that would have **re-baselined the shared prefix for no benefit** (and risked a cache regression).
- ⚠️ Story 15 converts a deterministic safety gate into model judgement — a prompt regression could silently double-book. Mitigation is the default-deny posture in prompt + every tool-result and the user-set-only durable flag (carried from ADR 0011).
- ⚠️ Story 17 cannot ship "done" until the delivery worker (or interim direct-send) exists — the plan calls this out so it is not discovered mid-wave.
- ⚠️ The ~2–5/s draft cap is a guess against an undocumented limit; if Telegram publishes (or we measure) a real ceiling, the central cap is the one place to revise.

## Alternatives considered

### Keep the research dossier + backlog as the plan-of-record

Rejected: two docs with overlapping and partly **stale** content (notably the §G "latent cost bug" line) is exactly the drift the docs rules warn against. A single plan + this ADR is the source of truth; the research's verified facts and source URLs are preserved in the plan.

### Order by feature visibility (ship the flashy streaming first)

Rejected: streaming (13) needs the messenger primitives (10) and the status surface (12); the lock (11) must precede the queue-after (14). Dependency-and-risk ordering beats demo-order — and isolates the two dangerous waves (C, D).

### Bundle Story 15 into the streaming/UX waves

Rejected: it is the only safety-critical reversal (deletes a deterministic guard) and deserves a dedicated wave with the held-spec replacement as the merge gate, not to be reviewed alongside unrelated UX churn.

## References

- The plan this records: [ai-workflow-v2-plan](../specs/ai-workflow-v2-plan.md)
- Current as-built state: [ai-workflow](../specs/ai-workflow.md) · the layer model: [assistant-layered-architecture §the layer model](../specs/assistant-layered-architecture.md#the-layer-model)
- The decision Story 15 supersedes (layer 4 only): [ADR 0006](0006-assistant-schedule-context-and-conflicts.md) · the reversal: [ADR 0011](0011-assistant-ai-judged-conflicts.md)
- Per-story decision records: [ADR 0012](0012-assistant-stateful-messenger-and-draft-streaming.md) · [ADR 0013](0013-assistant-message-debounce-and-cancellation.md) · [ADR 0014](0014-assistant-per-user-personality.md) · [ADR 0015](0015-assistant-daily-report-scheduler.md) · [ADR 0010](0010-assistant-ask-user-stateful-resume.md)
- Corrected Assumption 1 source: [ADR 0016 A4](0016-assistant-ai-comms-audit-hardening.md) · [ai-comms-cc-audit §A4/§B](../specs/ai-comms-cc-audit.md)
- Story 17 delivery prerequisite: [notification-delivery](../specs/notification-delivery.md)
</content>
