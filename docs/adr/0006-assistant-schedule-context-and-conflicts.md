# 0006 — assistant-schedule-context-and-conflicts

- **Status**: Accepted
- **Date**: 2026-05-31
- **Deciders**: @danil

## Context

The assistant's write tools (`create_event` / `update_event`) are only as good as the schedule context behind them ([specs/telegram-ai-assistant.md](../specs/telegram-ai-assistant.md)). Three forces pull against each other:

- The model needs to know existing events to place things sensibly and avoid clashes.
- We cannot load the whole calendar every turn — unbounded cost, and it breaks the caching design ([ADR 0004](0004-assistant-prompt-composition-and-caching.md)).
- Correctness must **not** depend on the model choosing to look. A silent double-booking is unacceptable.

We mapped the option space as push / pull / validate / forcing-function strategies, plus a representation axis (compact free/busy vs. full event detail).

## Decision

Schedule truth reaches a tool decision through **four layers**, cheapest first; correctness ultimately does not depend on the model.

1. **Preloaded week (push).** Every turn injects **today + the next 7 days** of events (compact) into the volatile region of the prompt (block 5 of [ADR 0004](0004-assistant-prompt-composition-and-caching.md)).
2. **Query-aware augmentation (smart push).** A cheap pre-pass (deterministic Luxon date parsing, Haiku fallback) extracts date references from the user message and loads exactly those slices in addition to the week.
3. **On-demand fetch (agentic pull), capped at 5 per user-message turn.** The model may request additional dates/ranges via `list_events`; the orchestrator pulls and continues the loop. Past 5 fetches, further requests are refused and the model proceeds with what it has.
4. **Server-side validation, resolved with the user (deterministic floor).** Writes are overlap-checked in the backend. On conflict the write is **held** (Redis, short TTL) and the **user is asked to confirm** via inline keyboard — the model is **not** re-invoked. On confirm, the backend writes deterministically.

## Consequences

- ✅ The common near-term case (this week) needs zero extra round-trips (layer 1).
- ✅ Any date is covered without a huge eager window (layers 2–3).
- ✅ A silent double-booking is impossible regardless of model behavior (layer 4).
- ✅ Conflict resolution costs **no extra LLM call** — backend + user only.
- ✅ Per-turn token and round-trip cost stays bounded (fetch cap).
- ⚠️ The pre-pass adds complexity; implicit references ("after my trip") may be missed — layer 4 is the backstop.
- ⚠️ Conflict UX is reactive ("that overlaps…") rather than the model proactively avoiding it.
- ⚠️ A 5-fetch cap can truncate exotic many-date queries; the model is told and proceeds on partial data.
- ⚠️ Held conflicting writes need transient state (Redis + TTL) and an expiry path.

## Alternatives considered

### Validate, then return the conflict to the model to reconcile

The natural "agentic" variant: the write tool returns the clashing events and the model re-plans. Rejected — it costs an extra Sonnet round-trip per conflict, is nondeterministic (the model may propose *another* clashing slot), and is slower and pricier than simply asking the user. We keep conflict resolution deterministic and human-in-the-loop; the tool returns only a terminal "held for confirmation" status, never the conflict for the model to re-plan.

### Pure eager (load a large window / the full calendar)

Rejected — unbounded cost and still misses far-future dates. See [ADR 0004](0004-assistant-prompt-composition-and-caching.md).

### Pure agentic (no preload; the model always fetches)

Rejected — every turn pays extra round-trips and leans on the model remembering to look. Layer 1 removes that cost for the common case.

### Forcing-function tools (slot tokens, mandatory `dryRun`)

Rejected — too rigid for a natural-language secretary, and layer 4 already guarantees correctness without constraining the conversation.

### Unlimited on-demand fetches

Rejected — unbounded latency/cost and fetch-loop risk. Five is enough for realistic scheduling.

## References

- Feature design + the "Schedule context for tool decisions" section: [specs/telegram-ai-assistant.md](../specs/telegram-ai-assistant.md)
- Prompt block 5 / caching this builds on: [ADR 0004](0004-assistant-prompt-composition-and-caching.md)
- Provider + cheap-model pre-pass: [ADR 0003](0003-assistant-llm-provider-anthropic.md)
