# 0016 — assistant-ai-comms-audit-hardening

- **Status**: Accepted
- **Date**: 2026-06-20
- **Deciders**: @danil

## Context

The [AI-communication audit](../specs/ai-comms-cc-audit.md) reviewed claude-code (CC) communication practices against the cue-api assistant — an **async Telegram backend** (webhook → BullMQ `attempts:1` → tool loop → reply), not an interactive CLI. The audit confirmed the plan is already CC-literate and surfaced only surgical hardenings, every claim verified against live code (file:line cited throughout). The audit is now **Accepted (2026-06-20)**.

This ADR records the **five** CODE-NOW decisions accepted out of that audit as **Phase A hardening** — the small, correctness-bearing fixes worth shipping ahead of the larger v1 Foundation stories (sequencing in [ADR 0017](0017-assistant-ai-comms-implementation-scope.md)). They reconcile the multi-agent team's audit with the lead engineer's independent findings (L1–L4, all accepted) into one accepted list (A1–A5 in the [audit §A](../specs/ai-comms-cc-audit.md)). They are recorded together because each is a single, tightly-scoped change rather than its own architectural decision; the larger stories keep their own per-decision ADRs.

## Decision

We accept and will implement the following five hardenings (audit §A, A1–A5):

- **(A1) Terminal-handling overhaul** *(merges the lead engineer's L1 content-scan finding with the team's `MAX_TOKENS` finding)*. Two coupled changes to `runToolLoop`'s loop-and-terminal logic (`assistant.service.ts:350-363`): **(i)** the **continue** decision is driven by a **content scan** — continue **iff `toolCalls.length > 0`** — rather than the `stopReason !== TOOL_USE` gate, so a turn carrying `tool_use` blocks under another stop reason (e.g. `MAX_TOKENS` mid tool-call burst) is **still dispatched** rather than dropped; **(ii)** on a **no-tool-call terminal**, branch on `stopReason` before the generic return, splitting today's overloaded `result.text ?? ROUNDTRIP_CEILING_REPLY` (`:357`): `MAX_TOKENS` → an honest **"had to cut that short"** constant (NOT the truncated fragment, NOT the misleading "too many steps" ceiling text); `REFUSAL` → an honest **decline** constant (no retry); else → return text as today, reserving `ROUNDTRIP_CEILING_REPLY` for the genuine ceiling return at `:475`. A bounded `max_tokens` bump-retry is a **deliberately deferred** Phase-B refinement (safety on an `attempts:1` queue), not part of CODE-NOW.
- **(A2) Port every Zod field to `.describe()`** *(L2)*. Every field across the tool Zod validators (`tools/tool-schemas.ts`, which carried **no** `.describe()`) gets a `.describe()` so that, when Story 4's `buildTool` derives the model-facing JSON via `z.toJSONSchema()`, the model-steering descriptions survive the derivation. Without this, descriptions that today live only in the hand-written JSON block would be silently dropped on migration, weakening the model-facing contract.
- **(A3) Cap `list_tasks` / `list_groups` result size.** Add `MAX_LIST_LINES` beside `MAX_FREE_SLOTS` (`tool-dispatcher.service.ts:30`) and slice + append a `"(+N more …)"` tail in the `list_tasks` / `list_groups` handlers (today unbounded at `:246` / `:772`), **mirroring `find_free_slots`' `MAX_FREE_SLOTS`** bound. Bounds the most volatile, most-frequently-called reads (protecting the rolling-summary budget and prompt-cache economics) and steers the model to narrow rather than work off a silently-partial list. CC's disk-persistence / `<persisted-output>` machinery is **rejected** (no replay/transcript store here).
- **(A4) Tools are ALREADY cached by breakpoint #1 — correct the misdiagnosis, do NOT add a tool cacheBoundary** *(L3)*. Anthropic's prefix order is `tools → system → messages`; cache breakpoint #1 sits on system block 1 (`context-builder.service.ts:275`), so the tool definitions are **already swept into that cached prefix** (the builder's own comment is correct). The earlier "tool defs billed at full price every turn" framing (v2 §G / Story 18) was a **misdiagnosis**. The fix is to (1) correct the stale/false comment at `tool-schemas.ts:236-240` (which claims the last schema "carries `cacheBoundary`" when none does — grep count = 0) and the dead `ToolSchema.cacheBoundary` path (`ai.types.ts:74`, `connector.ts:253`), and (2) add **`cache_read` / `cache_creation` observability** so the already-cached behaviour is verifiable — **NOT** to wire a redundant tools-tail cache breakpoint. Story 18's cache-bug AC is **dropped** (see [ADR 0017](0017-assistant-ai-comms-implementation-scope.md) / audit §B).
- **(A5) Extend the graceful-failure net over context-building** *(L4)*. `contextBuilder.build()` ran **outside** `runToolLoop`'s try (`assistant.service.ts:315` vs `:334`) and `handleText` had no outer guard, so a prompt-assembly throw escaped → the consumer released dedupe + rethrew → under `attempts:1` (no redelivery) the user got **silence**. Move context assembly **inside** the try so a build failure yields `kind:'error' → AI_FAILURE_REPLY` like any other terminal failure (logged **loudly**), and fix the stale "BullMQ retries" comment in `webhook.consumer.ts`. **Every inbound message yields a reply.**

## Consequences

- ✅ **(A1)** A turn that carries tool-use blocks can never be dropped on an ambiguous stop reason; a truncated or refused terminal turn yields an **honest** reply instead of a confident half-answer or a misleading "too many steps".
- ✅ **(A2)** Story 4's `buildTool` migration cannot silently weaken model steering — the descriptions the model relies on ride through `z.toJSONSchema()` intact.
- ✅ **(A3)** The most volatile reads are bounded — protecting the rolling-summary token budget and prompt-cache economics — and the model is steered to narrow rather than act on a partial list.
- ✅ **(A4)** Kills a false-premise work item (no redundant breakpoint, no wasted wiring against the API's 4-breakpoint cap — system already uses 2), removes dead code + a misleading comment, and makes the real caching behaviour **observable** via `cache_read` rather than assumed.
- ✅ **(A5)** Closes the last "dead turn" hole: context-building errors now degrade to a graceful reply, upholding the `attempts:1` invariant that **every terminal path returns, never throws**.
- ⚠️ **(A1)** The continue/terminal split must stay covered by the existing loop specs (≈27 `*.spec.ts`); a careless change risks a regression in terminal-vs-continue behaviour. Mitigation: gated by lint + type + jest before it ships (see [ADR 0017](0017-assistant-ai-comms-implementation-scope.md)).
- ⚠️ **(A2)** Every Zod field must be touched — broad but mechanical; the cost is reviewer fatigue, not risk. A PR check that the derived JSON is *at least as descriptive* as today's hand-written block backstops it.
- ⚠️ **(A3)** A too-tight cap could hide a genuinely long week; set it generously (a normal week is well under 40 lines) and surface the `(+N more)` count so truncation is never silent.
- ⚠️ **(A4)** Adding `cache_read` observability is additive logging only; the upside is verification, not a behaviour change — the temptation to "fix" a non-bug is the thing being removed, not added.
- ⚠️ **(A5)** Wrapping context-building means a degraded reply can mask a real assembly bug; the graceful path must **log loudly** so the failure is still observable, not swallowed.

## Alternatives considered

The audit weighed and **rejected** the following CC machinery as not fitting an `attempts:1` Telegram backend. Recorded here so future-me does not re-litigate them:

### ToolSearch / `defer_loading`
Rejected — irrelevant at ~12 tools; the whole point is lazy-loading a large tool catalogue we do not have.

### MCP adapter / tool support
Rejected — no external MCP tool surface; pure overhead for a fixed in-process tool set.

### Sub-agent orchestration
Rejected — a single-calendar planner needs one agent, not a delegation tree.

### Parallel tool dispatch
Rejected — dispatch stays **serial, in emission order** for deterministic write ordering on one calendar (a deliberate divergence from CC read-parallelism).

### Plan mode
Rejected — an interactive-CLI affordance; there is no human-in-the-loop plan-approval step in an async webhook turn.

### Manual stream reassembly (CC's raw `content_block_delta` reassembler)
Rejected — a per-token-render perf optimisation; cue feeds throttled ≤5/s drafts and never renders per-token. The SDK `MessageStream` + `finalMessage()` path (Story 13) is what we use.

### Stop-hook structured output
Rejected — a CLI lifecycle hook with no analogue in the queue worker; the turn's terminal handling already owns the equivalent.

## References

- The accepted reconciled audit: [ai-comms-cc-audit.md](../specs/ai-comms-cc-audit.md) — §A (CODE-NOW A1–A5, these decisions), §B (PLAN-HARDENING), §"Deliberately NOT recommended"
- Scope & sequencing of all the audit work: [ADR 0017](0017-assistant-ai-comms-implementation-scope.md)
- The stories these hardenings touch: Stories 1/3/4 (shipped) as-built in [ai-workflow](../specs/ai-workflow.md); Stories 13/18 (v2) in [ai-workflow-v2-plan](../specs/ai-workflow-v2-plan.md)
- Current behaviour: [specs/ai-workflow.md](../specs/ai-workflow.md) §3 (caching), §6 (loop / terminal handling), §11 (resilience / failure net)
- Pattern source: `/Users/danil/personal-projects/claude-code-src/AI_COMMS_TOOLSET_RESEARCH.md`
