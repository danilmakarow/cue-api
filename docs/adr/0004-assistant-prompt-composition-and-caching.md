# 0004 — assistant-prompt-composition-and-caching

- **Status**: Accepted
- **Date**: 2026-05-31
- **Deciders**: @danil

## Context

Every assistant turn ([specs/telegram-ai-assistant.md](../specs/telegram-ai-assistant.md)) sends a system prompt, tool schemas, the user's profile/summary, the recent window, and the new message. Naively, much of this repeats on every call and across users, and we pay full input price for all of it. Prompt caching (chosen provider supports developer-controlled `cache_control` — [ADR 0003](0003-assistant-llm-provider-anthropic.md)) bills a cached prefix at a fraction of input price, **but only if the prefix is byte-identical to a prior call.** A single misplaced volatile token (e.g. the current timestamp near the top) defeats the entire cache.

So the order in which we assemble prompt blocks is itself an architectural decision, not an implementation detail.

## Decision

We compose every prompt in a fixed order — **most-stable/most-shared first, most-volatile last** — with **two cache breakpoints**:

```
1. System prompt        ┐ shared across ALL users, ~never changes
2. Tool definitions     ┘  ── cache breakpoint #1 ──
3. User memory/profile  ┐ per-user, changes rarely
4. Rolling summary      ┘  ── cache breakpoint #2 ──
5. Now context (timestamp + tz + agenda snapshot)  ┐
6. Recent window (verbatim)                        │ volatile, every turn
7. New user message                                ┘
```

Binding rules for all assistant code:

- **The current timestamp/"now" never goes above breakpoint #2.** It lives in block 5.
- **System prompt and tool schemas carry no per-user or per-turn data**, so breakpoint #1 is identical for every user and hits ~always.
- A change to a user's profile or summary invalidates only from breakpoint #2 down — the big shared prefix stays warm.

## Consequences

- ✅ Per-turn input is ~70–80% cache reads (~0.1× input price); target ≈ 3.5–6k input tokens/turn regardless of how long the conversation is.
- ✅ Breakpoint #1 is shared across the whole user base — multi-tenant caching, not per-user.
- ✅ Cost stays roughly flat as a conversation grows (the window is bounded; the summary is bounded — [ADR 0005](0005-assistant-conversation-memory-model.md)).
- ⚠️ **Summarization vs. caching tension:** rewriting block 4 invalidates the cached prefix from breakpoint #2 down. Mitigated by re-summarizing on a threshold (not every turn) so the prefix stays stable between summarizations.
- ⚠️ Cache entries have a TTL (default ~5 min; extended ~1 hr at higher write cost). Savings are largest within an active back-and-forth; idle gaps cold-start the cache. Acceptable — and tunable per metrics.
- ⚠️ The fixed order is a constraint every future contributor must respect; documented here and enforced in `context-builder.service.ts`.

## Alternatives considered

### One cache breakpoint (after tools only)

Simpler. Rejected: a per-user profile/summary update would either sit *outside* the cache (re-sent full price every turn) or, if placed in the cached region, invalidate the shared prefix. Two breakpoints separate "shared + stable" from "per-user + stable" so each is cached at its own natural cadence.

### No caching, rely on a small model + short prompts

Rejected: even a short prompt repeated every turn across many users is pure waste when the prefix is identical. Caching is the single highest-leverage cost lever and is nearly free to adopt given provider support.

### Large-context "stuff everything in" (no window/summary, no ordering discipline)

Rejected: per-turn cost grows linearly with conversation length and eventually hits the context limit; ordering still matters for caching regardless of window size. The bounded window + summary keeps cost flat.

## References

- Feature design + the full block table: [specs/telegram-ai-assistant.md](../specs/telegram-ai-assistant.md)
- Provider (enables developer-controlled caching): [ADR 0003](0003-assistant-llm-provider-anthropic.md)
- Memory model (defines blocks 3 and 4): [ADR 0005](0005-assistant-conversation-memory-model.md)
