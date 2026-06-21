# 0038 — assistant-messenger-primitives-status-session

- **Status**: Accepted
- **Date**: 2026-06-21
- **Deciders**: @danil

## Context

This is **Story 10** of the v2 plan ([ai-workflow-v2-plan](../specs/ai-workflow-v2-plan.md)) — the dependency-free **L9 messenger foundation** that Stories 12 (live status) and 13 (response streaming) build on. [ADR 0012](0012-assistant-stateful-messenger-and-draft-streaming.md) already **decided** the stateful-messenger design and the draft-streaming surface; this ADR records the concrete **port + connector + egress primitives** that realize it, and the two L9 building blocks (the draft throttle and the `StatusSession`) — without any animation (Stories 12/13 own that).

Before this story the vendor port was the minimal v1 set (`sendMessage` / `sendActions` / `acknowledgeCallback` / `fetchMedia` / `registerWebhook` / `removeWebhook`); nothing could edit a message, show presence, delete, post an ephemeral draft, or dock a persistent reply keyboard. Three Verified Telegram facts ([ai-workflow-v2-plan §Verified Telegram streaming facts](../specs/ai-workflow-v2-plan.md#verified-telegram-streaming-facts)) bind the design:

1. `sendMessageDraft` is a **private-chat-only**, **~30 s ephemeral** preview that **animates natively** on re-call with the same `draft_id`, carries **no buttons**, renders the native "Thinking…" shimmer on **empty text**, and **must be finalized with a real `sendMessage`** to persist.
2. The **draft-call rate limit is undocumented** — Corrected Assumption 4 mandates a **central ~2–5/s cap** in L9 so every draft caller inherits it.
3. **Reply-keyboard taps arrive as plain text equal to the label** (not callbacks); a persistent keyboard sets `is_persistent` + `resize_keyboard` (Bot API 6.4) and is removed via `ReplyKeyboardRemove`.

## Decision

**Extend the L9 surface with the messenger primitives, a central draft throttle, and a Redis-backed idempotent `StatusSession` — all without animating anything.**

- **Port + Telegram connector gain five methods** (`external-vendor-connector.abstract.ts`, `telegram/telegram-vendor.connector.ts`), each mirroring the existing `callApi` pattern: `sendMessageWithKeyboard` (persistent reply keyboard / `ReplyKeyboardRemove`), `editMessageText`, `sendChatAction`, `deleteMessage`, `sendMessageDraft`. New vendor-agnostic DTOs (`ChatType`, `ChatAction`, `EditMessage`, `MessageDraft`, `ReplyKeyboard*`, `OutboundKeyboardMessage`) live in `external-vendor.types.ts`; the Telegram wire shapes stay private to the connector folder. **All v1 send paths are byte-for-byte unchanged.**
- **`sendMessageDraft` is GATED to private chats at the connector boundary.** It throws when `SendTarget.chatType` is set and not `ChatType.Private` (degrade to `editMessageText` elsewhere). To support the gate, the inbound normalizer now surfaces `chatType` on `NormalizedInboundMessage` (mapped from Telegram `chat.type`). The full draft contract — ephemeral 30 s, same-`draftId` re-call as the update mechanism, empty-text "Thinking…", no buttons, **finalize with a real `sendMessage`** — is documented **on the port method** so every future caller reads it at the call site.
- **A central draft throttle** (`reply/draft-throttle.ts`) caps draft updates at ~2–5/s (default 4, clamped into the band). It is **leading-edge + trailing-coalescing**: the first update fires immediately, bursts retain only the **latest** pending frame (a draft is a full-text replacement, so older partials are always superseded), and a single trailing flush fires at the window boundary. `cancel()` clears the timer in the caller's `finally` (timer-leak guard, ADR 0012). It lives in L9 so Story 12's dot/word cadence and Story 13's streaming both inherit one cap.
- **`StatusSession` is a Redis-backed, IDEMPOTENT live-status handle** (`reply/status-session.store.ts`), keyed **per chat + turn** (`assistant:status:{chatId}:{turnId}`). `open()` uses `SET NX` so a second `open` for the same turn — a concurrent webhook or a replayed BullMQ job if `attempts` is ever raised above 1 — **loses the race and re-reads the existing handle rather than orphaning a second draft/message**. The handle records the surface kind (private ⇒ ephemeral draft keyed by `draftId`; non-private ⇒ real message keyed by `vendorMessageId`), locale, and a `phase` lifecycle (`Thinking → Working → Streaming`). The store owns only **create / get / advancePhase / clear**; the animation is Stories 12/13.
- **New config + Redis key.** `ASSISTANT_STATUS_SESSION_TTL_SECONDS` is added to the Zod env schema (+ `.env`/`.env.test`/`.env.example`) and surfaced via `AssistantConfig.statusSessionTtlSeconds`; `statusSessionKey()` joins `redis.constants.ts` beside the other assistant keyspaces. `StatusSessionStore` is registered in `assistant.module.ts`. **No new DB entity** — Story 10 is Redis-only.

This story is **additive and behaviour-preserving**: existing send paths and their specs are untouched; the new code ships with unit specs for the throttle (cap + coalescing + cancel), `StatusSession` idempotency (NX race, concurrent open), and the draft private-chat gate.

## Consequences

- ✅ The full stateful-messenger surface ADR 0012 designed now exists behind the vendor-agnostic port — Stories 12/13 plug in with no further connector work.
- ✅ **One** draft throttle governs all draft callers; the undocumented rate limit is contained at a single, easily-revisited point (Corrected Assumption 4).
- ✅ `StatusSession` idempotency makes the live-status surface **safe under replay/concurrency** ahead of the higher-risk Story 14 — the design's "no orphaned second message" guarantee is structural (`SET NX`), not convention.
- ✅ The draft private-chat gate fails **closed at the connector** — a non-private caller cannot accidentally post a draft; it must take the degraded `editMessageText` path deliberately.
- ⚠️ The throttle is **in-process** (one instance per live status/stream), not Redis-distributed — correct for a per-turn animation, but it does **not** coordinate across workers; if two workers ever animate the same chat concurrently the per-chat send budget is shared only by Telegram's own 429, not by this cap. Acceptable because the Story 11 per-user lock serializes a user's turns.
- ⚠️ `chatType` is now threaded through inbound normalization and `SendTarget`; callers that omit it keep the v1 behaviour (drafts allowed, no gate trip), so the gate only bites when the chat kind is actually known.
- ⚠️ A new **required** env var (`ASSISTANT_STATUS_SESSION_TTL_SECONDS`) means every environment must supply it or boot fails (the deliberate fail-loud posture); added to all env templates in this change.

## Alternatives considered

### Put the throttle inside the connector / each caller

Rejected — the connector is the vendor boundary and should stay a thin wire mapper; per-caller throttles would each re-derive the cap and drift. L9 is the documented home (Corrected Assumption 4), and one shared limiter is the whole point.

### Make `StatusSession` a DB entity

Rejected — a live-status handle is ephemeral per-turn state with a short TTL; the strict 3-layer DB pattern is for durable records. Redis (with `SET NX` for idempotency) is the right tier, matching the held-conflict store's Redis-only precedent.

### Key `StatusSession` per chat only

Rejected — concurrent turns in one chat would then share (and clobber) a single status surface. Keying per **chat + turn** keeps each turn's surface isolated while still making a re-entrant `open` within one turn idempotent.

### Add `sendRichMessageDraft` now

Rejected for v2 (mirrors ADR 0012) — it needs Bot API 10.1+ clients and a rich formatter; plain `sendMessageDraft` covers the user base today.

## References

- The design this realizes: [ADR 0012 — stateful messenger + draft streaming](0012-assistant-stateful-messenger-and-draft-streaming.md)
- Story row + Verified Telegram facts + Corrected Assumption 4 (the ~2–5/s cap): [ai-workflow-v2-plan](../specs/ai-workflow-v2-plan.md)
- The L9 egress layer this extends: [assistant-layered-architecture §the layer model](../specs/assistant-layered-architecture.md#the-layer-model)
- The connector port contract: [ADR 0007](0007-provider-connector-abstraction.md)
- The STOP control that rides a separate real message (not a draft): [ADR 0013](0013-assistant-message-debounce-and-cancellation.md)
