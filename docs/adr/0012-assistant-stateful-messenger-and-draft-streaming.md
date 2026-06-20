# 0012 — assistant-stateful-messenger-and-draft-streaming

- **Status**: Accepted
- **Date**: 2026-06-19
- **Deciders**: @danil

## Context

The messenger port is **stateless and minimal**: `ExternalVendorConnector` exposes only `sendMessage`, `sendActions`, `acknowledgeCallback`, `fetchMedia`, `registerWebhook`, `removeWebhook`; the Telegram connector is raw `fetch` + a private `callApi<T>` with **no SDK**. Today nothing is shown until the full reply is ready, and the reply is one static message.

v2 wants an **instant living status** and the answer **streaming in**. Verified against the live Telegram docs:

- **`sendMessageDraft`** (Bot API 9.3; all bots since 9.5) "streams a partial message to a user while the message is being generated". The streamed draft is an **ephemeral 30-second preview**; you update it by **re-calling with the same `draft_id`** (Telegram **animates the transition client-side**), and you **must finalize with a real `sendMessage`** to persist it. **Empty text → a native "Thinking…"** placeholder. **Private chat only.** It carries **no `reply_markup`** (no buttons). There is **no documented rate-limit exemption** for draft calls.
- The installed `@anthropic-ai/sdk@0.100.1` **already exposes `client.messages.stream()`** — no upgrade needed.
- A literal **25 ms animation is infeasible** as server edits (~40 edits/s → HTTP 429); the draft's native client-side animation gives the smooth feel for free.

## Decision

We make the messenger a **stateful surface**. Add `editMessageText`, `sendChatAction`, `deleteMessage`, `sendMessageDraft`, and a persistent **reply-keyboard** to the port, and carry a **Redis-backed per-turn `StatusSession`** `{ chatId, draftId | messageId, phase, locale }`. We use **`sendMessageDraft` as both the live-status surface and the response-streaming surface**: post an immediate draft (empty text → "Thinking…"), cycle the status **word every 5 s** with **dots animating every 500 ms**, stream the final answer's text via **throttled** draft updates, then **finalize with a real `sendMessage`** that persists `vendorMessageId`. Per-step recaps (one sentence, "what I'm doing now") are produced by the **BACKGROUND (Haiku)** model and written into the status draft between rounds. All draft use is **gated to private chats** (degrade to rate-limited `editMessageText` elsewhere) and **throttled conservatively (~2–5/s)** since no exemption is documented. Response streaming uses the SDK's existing `messages.stream()`. Status-message creation is **idempotent** (Redis check) so it stays safe if the BullMQ queue's `attempts` is ever raised above 1.

## Consequences

- ✅ Instant, animated feedback **and** a streamed answer — the core of the "feels like a person" UX.
- ✅ **One** primitive (the draft) serves status *and* streaming; no `editMessageText` flood-fighting.
- ✅ No SDK upgrade (`messages.stream()` already present).
- ⚠️ Drafts are **private-chat only** and **ephemeral (30 s)** — callers must keep-alive within the TTL and finalize with `sendMessage`; non-private needs a degraded path.
- ⚠️ Drafts carry **no buttons** — STOP and other in-turn controls need a **separate real message** (see [ADR 0013](0013-assistant-message-debounce-and-cancellation.md)).
- ⚠️ Draft throttle is **undocumented** — conservative ~2–5/s; revisit if Telegram publishes a number.
- ⚠️ Streaming + the **context-editing beta** is unverified (`client.beta.messages.stream()`) — verify before combining; otherwise stream only on non-context-edited turns.
- ⚠️ The animation `setInterval` must be **cleared in a `finally`** (timer-leak risk if the job ends/throws).

## Alternatives considered

### `editMessageText` for everything

Rejected — the ~1 edit/s-per-chat ceiling makes the word cycle coarse and a sub-second animation impossible (429). Kept only as the **non-private fallback**.

### `sendRichMessageDraft` (rich/formatted) as the primary surface

Rejected for v2 — it landed in Bot API 10.1 (days ago), needs 10.1+ clients and a rich formatter; plain `sendMessageDraft` covers the entire user base today. Rich is an opt-in follow-up.

### Adopt grammY / Telegraf for draft support

Rejected — raw `callApi` already works and the repo is deliberately lean on dependencies; the draft methods are thin additions.

### Reuse the main model for per-step recaps

Rejected — it changes the final-reply UX and needs prompt surgery; a Haiku `completeStructured` recap is cheap and leaves the main reply intact.

## References

- Research: [ai-workflow-v2-research §A / §C](../specs/ai-workflow-v2-research.md) · design: [ai-workflow-tasks Stories 10/12/13](../specs/ai-workflow-tasks.md)
- Recaps stay in the volatile tail, never the cached prefix: [ADR 0004](0004-assistant-prompt-composition-and-caching.md)
- The STOP control that rides a separate message: [ADR 0013](0013-assistant-message-debounce-and-cancellation.md)
</content>
