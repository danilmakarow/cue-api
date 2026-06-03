# 0005 — assistant-conversation-memory-model

- **Status**: Accepted
- **Date**: 2026-05-31
- **Deciders**: @danil

## Context

The assistant ([specs/telegram-ai-assistant.md](../specs/telegram-ai-assistant.md)) is one perpetual conversation per user with no visible session boundaries. It must stay coherent across hundreds of turns and remember durable habits ("no meetings before 10", "gym Mon/Wed/Fri") — without resending the whole transcript each call (cost) and without losing precision on calendar specifics (correctness). "Memory" here is really three different needs: what was just said, what happened earlier in this thread, and what is durably true about the user.

## Decision

We use a **three-tier memory model**, each tier handling one need:

1. **Recent window (verbatim).** The last ~6–10 messages are sent as-is. Recency carries the most signal.
2. **Rolling summary (episodic).** Everything older is folded into a running summary via the background model: `previous_summary + oldest_turns → new_summary`. Recursive, so summary length is bounded regardless of conversation length. Triggered when the window crosses a token threshold — **not** every turn.
3. **Structured profile (semantic).** Durable, typed facts are extracted after each turn into a `UserMemoryFact` table (type, key, value, confidence, source). Only the relevant subset is injected per turn.

**Postgres (our DB) is the system of record** for all three tiers (`Conversation`, `ConversationMessage`, `ConversationSummary`, `UserMemoryFact`). The provider's native context editing (`clear_tool_uses`) is used *only* for transient tool-result hygiene within a turn, not as a store.

We never summarize: the structured profile, an event currently being edited, or a pending confirmation — those stay structured/verbatim.

## Consequences

- ✅ Per-turn token cost stays roughly flat as the conversation grows (window bounded, summary bounded).
- ✅ The assistant "knows the user" via the profile without replaying history — feels like a real secretary.
- ✅ Facts are queryable and **editable from the iOS settings screen**, so the user can see and correct what the assistant believes.
- ✅ Vendor-independent: conversation state isn't trapped in a provider thread format (supports the single-provider risk mitigation in [ADR 0003](0003-assistant-llm-provider-anthropic.md)).
- ✅ Profile and summary slot cleanly into prompt blocks 3 and 4 of [ADR 0004](0004-assistant-prompt-composition-and-caching.md).
- ⚠️ Summarization is lossy — a fact buried only in mid-conversation prose can be dropped. Mitigated by extracting durable facts into the profile (tier 3) *before* those turns age out of the window.
- ⚠️ Background extraction/summary cost on every turn — kept negligible by running on the cheap model ([ADR 0003](0003-assistant-llm-provider-anthropic.md)).
- ⚠️ More moving parts (three tiers + four tables) than "just store messages".

## Alternatives considered

### Resend full history every turn

Simplest. Rejected: linear cost growth and an eventual hard context-limit wall. The window + summary keep cost flat.

### Summary only, no structured profile

Cheaper to build (one tier). Rejected: summaries are lossy narratives, so durable preferences degrade over time and across summarizations. A typed profile preserves them exactly and lets the user edit them.

### Provider memory tool / managed thread as the store

Less plumbing. Rejected: it makes the vendor the system of record for user data, is hard to query/edit from the app, and couples us to a thread format. Native context editing is still used, but only for transient tool-result trimming — not as a store.

### Drop-in memory layer (Mem0 / Zep / Letta)

Automatic extraction and graph/temporal features. Rejected for v1: heavyweight dependency and an external system of record when a flat typed fact table + a cheap extraction prompt covers the calendar use case and keeps data in our DB. Revisit if memory needs outgrow a flat table. Consistent with the project's "own/vendor over new deps" preference.

### Semantic retrieval (embed every turn, retrieve relevant ones)

Powerful for referencing distant history. Deferred (not rejected): adds a vector store and retrieval latency for a payoff most scheduling chats don't need. Tracked as an open question in the spec (`ConversationMessageEmbedding` + pgvector).

## References

- Feature design: [specs/telegram-ai-assistant.md](../specs/telegram-ai-assistant.md)
- Where profile/summary sit in the prompt: [ADR 0004](0004-assistant-prompt-composition-and-caching.md)
- Provider + cheap-model split: [ADR 0003](0003-assistant-llm-provider-anthropic.md)
