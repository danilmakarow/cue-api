# 0003 — assistant-llm-provider-anthropic

- **Status**: Accepted
- **Date**: 2026-05-31
- **Deciders**: @danil

## Context

The Telegram AI assistant ([specs/telegram-ai-assistant.md](../specs/telegram-ai-assistant.md)) needs an LLM that:

- does reliable **tool/function calling** (the whole feature is "read/write the calendar via tools");
- supports **prompt caching** we can control, since the system prompt + tool schemas repeat on every turn and are identical across users;
- offers a **cheap model** for high-frequency background jobs (summarization, fact extraction, routing) and a **strong model** for the reasoning/booking turn;
- ideally provides **native context-management** primitives for tool-heavy loops.

Token cost is the dominant operating expense, and the product targets public scale, so per-turn economics matter from day one. The realistic candidates are Anthropic (Claude), OpenAI (GPT), and Google (Gemini).

## Decision

We build the assistant on **Anthropic Claude**, with a two-model split: **Claude Sonnet** (4.6 at time of writing) for the main tool-using reasoning turn, and **Claude Haiku** (4.5 at time of writing) for background jobs (summary, memory extraction, triage). Model ids are configurable via `ASSISTANT_MODEL_MAIN` / `ASSISTANT_MODEL_BACKGROUND` env vars; the *decision* is the provider + the Sonnet-for-reasoning / Haiku-for-background split, not the exact version strings.

## Consequences

- ✅ Best-in-class tool use and instruction-following for the booking/confirmation loop.
- ✅ **Developer-controlled prompt caching** (`cache_control` breakpoints) — enables the shared-prefix design in [ADR 0004](0004-assistant-prompt-composition-and-caching.md): cache reads at ~0.1× input price.
- ✅ **Native context editing** (`clear_tool_uses`) auto-evicts stale tool results — a direct fit for a bot that makes many `list_events` calls per turn.
- ✅ Haiku is cheap and fast enough that summarize/extract/route cost is near-negligible, cutting a large slice of total spend.
- ⚠️ **Single-provider dependency.** No automatic fallback if Anthropic has an outage. Mitigated by keeping the provider behind a thin `claude.client.ts` wrapper so a second provider could be added later, and by holding conversation state in our own DB (not provider-managed) so we are not locked to a vendor thread format.
- ⚠️ Exact model ids drift over time; we accept periodic version review rather than pinning forever.

## Alternatives considered

### OpenAI (GPT, Responses API)

Strong multimodal/voice story and automatic prompt caching. Lost on two points: caching is *implicit* (less control over the shared-prefix design we want), and its headline conversation-state convenience (`previous_response_id`) still bills all prior input tokens, so it isn't the cost lever it appears to be. Tool use is comparable; not enough to outweigh Claude's explicit caching + context editing for this tool-heavy workload.

### Google Gemini

Cheapest per token at scale and a very large context window. Lost because the large window invites the "just stuff everything in" anti-pattern this design explicitly avoids, explicit prompt caching/context-management ergonomics are weaker for our shared-prefix approach, and tool-use reliability for the confirm-before-mutate loop weighed toward Claude. Remains the strongest candidate if cost pressure later forces a re-evaluation.

### Single powerful model for everything (no Haiku split)

Simplest routing — one model, one code path. Rejected: summarization, fact extraction, and triage are frequent and don't need a frontier model. Routing them to Haiku removes a large, recurring cost with negligible quality loss.

## References

- Feature design: [specs/telegram-ai-assistant.md](../specs/telegram-ai-assistant.md)
- Caching strategy that depends on this provider: [ADR 0004](0004-assistant-prompt-composition-and-caching.md)
- Memory model (state kept in our DB, not provider-managed): [ADR 0005](0005-assistant-conversation-memory-model.md)
