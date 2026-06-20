# 0017 — assistant-ai-comms-implementation-scope

- **Status**: Accepted
- **Date**: 2026-06-20
- **Deciders**: @danil

## Context

The [AI-communication audit](../specs/ai-comms-cc-audit.md) is Accepted (2026-06-20) — a reconciliation of the multi-agent team's audit with the lead engineer's independent findings — and its five CODE-NOW hardenings (A1–A5) are recorded in [ADR 0016](0016-assistant-ai-comms-audit-hardening.md). Separately, [ai-workflow-tasks.md](../specs/ai-workflow-tasks.md) holds the full backlog: **v1 Foundation** (Stories 1–9) and **v2 Conversational UX** (Stories 10–18). We need an explicit, recorded order of work and a quality bar so the assistant hardening proceeds predictably rather than ad hoc — particularly because v2 includes a story ([0011](0011-assistant-ai-judged-conflicts.md)) that supersedes an already-accepted ADR.

## Decision

AI-communication work proceeds in three phases, with v2 explicitly gated behind human review:

- **Phase A — accepted audit findings (this work).** Ship the **five** CODE-NOW hardenings (A1–A5) from [ADR 0016](0016-assistant-ai-comms-audit-hardening.md): **A1** terminal-handling overhaul (content-scan continue-signal **+** honest `MAX_TOKENS`/`REFUSAL` terminal branches); **A2** `.describe()` on every Zod field; **A3** cap `list_tasks`/`list_groups` result size; **A4** correct the cacheBoundary misdiagnosis (fix the stale comment + add `cache_read` observability, no new breakpoint); **A5** extend the graceful-failure net over context-building (+ fix the stale `webhook.consumer.ts` comment).
- **Phase B — v1 Foundation (Stories 1–9).** Implement the v1 stories in the **documented suggested order** ([ai-workflow-tasks §"Stories at a glance"](../specs/ai-workflow-tasks.md)): **3 (`AiToolChoice` + the 529 → fallback-model swap — the top failure-handling item)** → **1 (full narration re-drive — the complete classify → corrective user message → forced `tool_choice:'any'` → retry ≤5 → escalate, on top of A1's terminal split)** → 2 (`create_tasks`) → 4 (`buildTool`, carrying the A2 `.describe()` AC + derivation guards) → 6 (router) → 5 (`ask_user`) → 7 (`check_availability`) → 8 (layered decomposition, the vehicle hosting 1–7) → 9 (write-side recurring-conflict gap). Each story is **gated by lint + type + jest** (`pnpm run lint`, `pnpm run type`, `pnpm jest`) before it merges, and **each architectural decision gets its own ADR** (Stories 1, 5 already have ADRs 0009, 0010).
- **Phase C — E2E real-request tests.** After the Phase B features pass their **unit tests**, add end-to-end tests that exercise **real requests** through the pipeline (webhook → loop → reply). E2E follows unit, never replaces it.
- **v2 (Stories 10–18) is DEFERRED to explicit human review.** No v2 story starts until @danil signs off — most pointedly Story 15 / [ADR 0011](0011-assistant-ai-judged-conflicts.md), which *supersedes* the accepted [ADR 0006](0006-assistant-schedule-context-and-conflicts.md) layer 4.

## Consequences

- ✅ A single recorded order replaces "what next?" — Phase A is cheap and lands while the relevant stories are still Draft (the audit's stated reason to do it now).
- ✅ Every Phase B story carries the same quality gate (lint + type + jest) and its own ADR, so architectural decisions stay one-per-file and immutable (per the doc conventions).
- ✅ E2E-after-unit keeps the feedback loop fast: features prove correctness in unit tests first, then the slower real-request harness confirms integration.
- ✅ The v2 deferral protects an accepted decision — nothing reverses ADR 0006 (or builds the heavier streaming/UX surface) without an explicit human gate.
- ⚠️ Phase B is a long sequence; the suggested order has soft dependencies (1 wants 3 first; 8 hosts 1–7) — a re-order mid-flight would need this ADR superseded, not edited.
- ⚠️ Gating each story on the full lint/type/jest trio is friction on small PRs; accepted as the price of not regressing the ≈27 existing specs.
- ⚠️ Deferring all of v2 means the "feel like a person" UX waits on a review that has no scheduled date — intentional: correctness (v1) before conversational polish (v2).

## Alternatives considered

### Fold Phase A into the v1 stories (no separate hardening phase)
Rejected — the audit's value is that these fixes are cheap **now**, while Stories 1/4/18 are still Draft; deferring them into those stories loses the "fix the spec before it ships" window and risks the misdiagnosed cacheBoundary "bug" justifying wasted work (ADR 0016 A4).

### Ship v1 and v2 as one continuous backlog
Rejected — v2 Story 15 supersedes an accepted ADR (0006) and the v2 streaming/UX surface is a *new application version* on top of the v1 foundation. Bundling them removes the human checkpoint before a safety-relevant reversal.

### E2E tests up front (test-first at the integration layer)
Rejected — a real-request harness is slow and brittle to iterate against during feature build-out; unit tests gate each story, E2E confirms the assembled pipeline afterwards.

### No per-story ADRs (one big "assistant hardening" ADR)
Rejected — violates the one-decision-per-file, immutable convention; future-me needs each architectural decision evaluable on its own.

## References

- The accepted reconciled audit + its five CODE-NOW hardenings (A1–A5) and PLAN-HARDENING list: [ai-comms-cc-audit.md](../specs/ai-comms-cc-audit.md) · [ADR 0016](0016-assistant-ai-comms-audit-hardening.md)
- The backlog this sequences: [ai-workflow-tasks.md](../specs/ai-workflow-tasks.md) (v1 Stories 1–9, v2 Stories 10–18)
- Per-story decisions already recorded: [0009](0009-assistant-narration-redrive.md) (Story 1) · [0010](0010-assistant-ask-user-stateful-resume.md) (Story 5) · the deferred v2 supersede: [0011](0011-assistant-ai-judged-conflicts.md) ⟂ [0006](0006-assistant-schedule-context-and-conflicts.md)
- Current behaviour: [specs/ai-workflow.md](../specs/ai-workflow.md)
