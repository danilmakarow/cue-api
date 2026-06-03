# 0007 — provider-connector-abstraction

- **Status**: Accepted
- **Date**: 2026-05-31
- **Deciders**: @danil

## Context

The Telegram AI assistant ([specs/telegram-ai-assistant.md](../specs/telegram-ai-assistant.md)) depends on two third-party integrations: a **messaging transport** (Telegram) and an **LLM provider** (Anthropic). Both are explicitly things we expect to swap or extend — [ADR 0003](0003-assistant-llm-provider-anthropic.md) names single-provider lock-in as a risk to mitigate, and a second consumer of Telegram already looms ([specs/notification-delivery.md](../specs/notification-delivery.md) sends reminders over the same channel).

The repo had no pattern for external-service integration. `AppleTokenVerifier` is a one-off injectable wrapping a vendor, with no notion of swapping it. If each integration is hard-coded into the feature that uses it, replacing or adding a provider becomes a rewrite, and orchestration code ends up coupled to vendor SDK shapes. We decide the structure once so both connectors — and future ones (a second LLM, STT, WhatsApp, the APNs sender) — share it.

## Decision

We integrate each category of external service through a **provider-agnostic connector**, packaged as its own top-level module with four parts:

1. **Abstract base contract** (`XConnector`) — the handler methods every implementation must provide, expressed over **normalized DTOs**, never vendor payloads.
2. **Capability flags** (`XCapabilities`) — declared per implementation so callers degrade gracefully instead of assuming one vendor's features.
3. **Typed config** (`XConfig`) — sourced from the Zod-validated env, including a discriminator that selects the active provider.
4. **Factory** (`XConnectorFactory`) — resolves the active implementation from config, **fails fast at startup** on an unknown/misconfigured provider, and exposes `getActive()` plus `get(provider)` for a future multi-provider world.

The module exports the factory and an `ACTIVE_X_CONNECTOR` token; consuming feature modules import it and depend only on the abstract type. The first two instances are `src/modules/external-vendor/` (Telegram) and `src/modules/ai/` (Anthropic). The abstraction stays **thin** — one unit of work per call (one message send, one model round-trip); orchestration and policy (e.g. the tool-loop and 5-fetch cap in [ADR 0006](0006-assistant-schedule-context-and-conflicts.md)) live in the consuming feature, not the connector.

## Consequences

- ✅ Swapping or adding a provider is a new implementation + a config flip, not a rewrite — realizes the vendor-independence intent of [ADR 0003](0003-assistant-llm-provider-anthropic.md).
- ✅ Orchestration depends on a stable contract; vendor SDK churn is contained behind the boundary.
- ✅ Misconfiguration surfaces at boot (fail-fast factory), not at the first user message.
- ✅ One consistent shape across integrations lowers ramp cost; future STT / second LLM / shared Telegram egress slot into the same mold.
- ✅ Feature logic is testable against the abstract contract with a fake connector — no network in unit tests.
- ⚠️ Up-front indirection for what is, today, a single implementation per category (YAGNI tension). Justified by the explicit multi-provider goal and the fact that there are already **two** categories with a third consumer pending.
- ⚠️ Leaky-abstraction risk: provider-specific features (Anthropic `cache_control`, Telegram inline keyboards) must be modeled generically — cache-boundary markers, capability flags — or they bleed through. The contract must be curated as new providers arrive.
- ⚠️ More wiring than a direct client (module + factory + token), and one more env discriminator (`EXTERNAL_VENDOR`, `ASSISTANT_AI_PROVIDER`) to validate and document — paid once per category.

## Alternatives considered

### Direct vendor clients inside the assistant module

The spec's original sketch — an inline `telegram.client.ts` and `llm/claude.client.ts`. Attractive: least code, no indirection, matches "don't build for needs you don't have." Rejected because the assistant explicitly wants a swappable transport and provider, a second Telegram consumer already exists, and hard-coding couples orchestration to vendor SDKs — making any swap or addition a rewrite of the feature.

### Interface only, no factory — bind the implementation with a Nest provider

Lighter: a plain `useClass`/`useFactory` per env, no registry. Rejected as insufficient on its own — we still want fail-fast resolution on bad config, `get(provider)` for multi-vendor, and capability flags carried at runtime. The factory is a thin layer *over* exactly this provider binding; it is the explicit seam, not a replacement for DI.

### One generic `IntegrationModule` for all external calls

A single abstraction covering every third-party call. Rejected as over-general: a messaging transport (send/receive messages, media, callbacks) and an LLM (complete-with-tools, caching, token usage) share no meaningful contract. A unified interface would collapse to a lowest-common-denominator mess. We keep **one abstraction per category**, sharing only the structural pattern (base + capabilities + config + factory), not a single interface.

### A drop-in integration framework / SDK aggregator

Offload the abstraction to a third-party package. Rejected: a heavyweight dependency with external opinions, overkill for two integrations, and counter to the project's "vendor/own over new deps" preference.

## References

- The two instances: [external-vendor connector task](../tasks/ai-assistant-1-external-vendor-connector.md) · [AI connector task](../tasks/ai-assistant-2-ai-connector.md)
- Consumer that wires both: [application-wiring task](../tasks/ai-assistant-3-application-wiring.md)
- Feature design: [specs/telegram-ai-assistant.md](../specs/telegram-ai-assistant.md)
- Provider/model decision this enables: [ADR 0003](0003-assistant-llm-provider-anthropic.md)
- Caching constraints the AI connector must honor: [ADR 0004](0004-assistant-prompt-composition-and-caching.md)
- Loop/conflict policy that stays in the consumer, not the connector: [ADR 0006](0006-assistant-schedule-context-and-conflicts.md)
