# 0041 — assistant-native-response-streaming

- **Status**: Accepted
- **Date**: 2026-06-21
- **Deciders**: @danil

## Context

This is **Story 13** of the v2 plan ([ai-workflow-v2-plan](../specs/ai-workflow-v2-plan.md)) — the riskiest Wave-B story. It builds on Story 10 ([ADR 0038](0038-assistant-messenger-primitives-status-session.md)) and Story 12 ([ADR 0040](0040-assistant-live-status-message.md)): the draft surface + central `DraftThrottle` + idempotent `StatusSessionStore` exist, and the live "Thinking…" / cycling-word animation already streams into the draft. Story 13 makes the **model's answer itself** stream into that same draft, and adds a **per-tool-round progress recap**.

Today the turn shows the animated loading words, then the full reply lands at once. The installed `@anthropic-ai/sdk@0.100.1` already exposes `client.messages.stream()` (and `client.beta.messages.stream()`) with a `text` event (delta + running snapshot) and `finalMessage()` — no upgrade needed. The draft surface is the streaming surface.

The constraints that bind the design (all load-bearing):

1. **DEGRADE, NEVER THROW INTO THE TURN.** The webhook queue is `attempts:1` — an uncaught throw drops the turn with **no retry**. Streaming a round must therefore never let a stream fault escape into the L4 loop.
2. **ALL draft updates route through the one `DraftThrottle`** (~2–5/s, undocumented Telegram limit). Per-token draft calls are forbidden — deltas must be batched/coalesced.
3. **ONE `StatusSession` + ONE throttle per turn** (Wave-A review note); the draft is **ephemeral (30 s)** and the **real `sendMessage` still persists** the answer.
4. The loop (L4) is **vendor / Redis / ORM-blind** — it must not learn about drafts to stream.
5. Recaps must use the **BACKGROUND (Haiku) model**, resolved from config — no hardcoded model id — and be cheap + best-effort.

## Decision

**Add a streaming `completeStream(request, onText)` to the `AiConnector` port (Anthropic impl over the SDK's `messages.stream()` + `finalMessage()`), drive the L4 loop's every round through it, render the answer + per-round recaps into the Story-12 draft via a surface-agnostic `TurnStreamSink`, and finalize with the existing real `sendMessage`.**

- **`AiConnector.completeStream(request, onText)` (L10).** Builds the SAME request as `complete()` (model, cached system blocks, tools, tool rounds, `max_tokens`, the 529→fallback posture — `buildCreateParams` is reused verbatim), streams via `client.messages.stream()` (or the beta stream when context editing is on), forwards each text delta to `onText(delta, snapshot)`, and returns the SAME normalized `CompletionResult` (`stopReason` / `toolCalls` / `text` / `usage`) `complete()` returns — so the loop is agnostic to whether a round streamed. **It MUST RETURN, NEVER THROW** (documented on the port): a captured snapshot of the streamed text lets any fault reconcile; on a stream error / abort / empty stream it falls back to a non-streamed `complete()` (which itself owns the MAIN-model 529→fallback-model retry), and if THAT also fails it returns a best-effort **partial result** (`OTHER` stop reason + the partial text + zero usage). A throwing `onText` is swallowed (the delta is simply not rendered) so a faulting status surface never aborts the stream.
- **`TurnStreamSink` (L4-facing port).** The loop streams the final round's answer + renders per-round recaps through this tiny interface (`streamAnswer(snapshot)` / `showRecap(recap)`), so it stays L9-blind. The turn runner (L3) supplies a concrete sink that wraps this turn's `StatusAnimation`; an `ask_user` resume (and any non-status turn) passes no sink and the loop runs exactly as before. Both methods are **degrade-never-throw** (each fires-and-forgets the animation's throttled push, which swallows its own fault).
- **Streaming the final round (L4 + L9).** The loop drives the model with `completeStream` on **every** round, with `onText` pushing the latest snapshot into the sink. On a terminal round (no tool calls) the streamed text IS the final answer — already animating in the draft; the existing `ReplyPresenter.sendText` then **finalizes with a real `sendMessage`** that persists `vendorMessageId`. `StatusAnimation.streamAnswer` stops the cycling-word/dots timers (the streamed text supersedes them), advances the phase to `Streaming`, and pushes through the **same throttle** so per-token deltas coalesce under the ~2–5/s cap — never a tight draft loop.
- **Per-round recaps (L11 → L9).** A new `RoundRecapService` turns one just-completed tool round's steps into a one-sentence present-tense line ("Checking Thursday afternoon") on the **BACKGROUND model** (the same role the summarizer / memory-extractor use, resolved via config — `ROUND_RECAP_SYSTEM_PROMPT`, `max_tokens` 32). The loop renders it into the draft between rounds via `sink.showRecap`. **Degrade-never-throw**: any model/parse fault (or an empty round) returns `null` and the loop leaves the current frame.
- **New prompt + provider.** `ROUND_RECAP_SYSTEM_PROMPT` joins `assistant.prompts.ts`; `RoundRecapService` is registered in `assistant.module.ts` and injected into `ToolLoopService`. No new env config (reuses the BACKGROUND model id + the existing draft throttle / status TTLs).

This story is **behaviour-preserving for the core contract**: the turn still answers, writes still happen, and the 4 ADR-0006 conflict cases + `ask_user` suspend/resume + correction re-drive all stay green (520 unit tests + the e2e pipeline). The loop's outcomes (`reply | held | ask | unresolved | error`) are unchanged. Existing unit/e2e expectations were updated **additively** for the new streaming (`completeStream`) and BACKGROUND-recap traffic — no core assertion weakened (the read-only-Q&A e2e now counts MAIN rounds, excluding the additive recap; the connector mock gained `messages.stream`; the scripted e2e connector's `complete` returns a canned recap for BACKGROUND so it never drains the MAIN script).

## Consequences

- ✅ **The answer streams in** — the user watches the reply compose itself in the same draft the loading words animated, then it persists as a real message.
- ✅ **Progress is visible on multi-round turns** — a cheap Haiku recap narrates each tool round ("Checking Thursday afternoon", "Booking the dentist") between rounds.
- ✅ **The loop never sees a throw from streaming** — `completeStream` reconciles a partial / falls back to non-streamed / returns a best-effort partial, honouring `attempts:1`. The four never-throw spec cases (stream-error, empty-stream, double-failure partial, throwing-onText) prove it.
- ✅ **Throttle-safe** — per-token deltas coalesce through the one Wave-A `DraftThrottle`; the vendor sees ≪ one send per token (a 5-snapshot burst flushes as 1–2 sends).
- ✅ **No SDK upgrade** — `messages.stream()` / `finalMessage()` already present in 0.100.1.
- ✅ **Loop stays L9-blind** — it speaks only the `TurnStreamSink` port; the turn runner wires it to the StatusAnimation.
- ⚠️ **Recaps cost one extra (cheap) BACKGROUND call per tool round.** Best-effort and capped at 32 tokens; a fault degrades to no recap. Acceptable for the progress UX; revisit if Haiku latency ever dominates a turn.
- ⚠️ **A streamed draft is still ephemeral (30 s).** A pathologically long final stream could outlive the TTL before `sendMessage` lands; the persisted reply is the durable artefact, so the worst case is a momentarily-blank status, never a lost answer.
- ⚠️ **Streaming + the context-editing beta is exercised but unverified against a live endpoint** (ADR 0012 caveat). The beta stream path is wired and unit-tested with a fake; combining it with real context edits should be confirmed before relying on it in prod.
- ⚠️ **Coupled to `attempts:1`.** The return-never-throw contract is the whole safety story; if the queue's attempts is ever raised, the partial-on-failure semantics (a half-streamed answer that then re-runs) need rework.

## Alternatives considered

### Stream only the final round (decide terminality before calling the model)

Rejected — the loop only knows a round is terminal *after* the model returns no tool calls, which is *after* streaming. Streaming **every** round with the snapshot routed to the sink is simpler and harmless: non-final rounds emit little/no text (mostly `tool_use`), and any brief narration is immediately superseded by the round's recap.

### Let `completeStream` throw and catch it in the loop

Rejected — it puts the never-throw burden on every caller and risks a missed catch dropping a turn (`attempts:1`). Making the **contract** "returns, never throws" — reconcile / fall back / partial inside the connector — is the single safe place to own it, and the port documents it so future callers inherit the guarantee.

### Reuse the MAIN model for recaps

Rejected — it would change the final-reply UX and burn MAIN tokens/latency on a throwaway progress line. A Haiku BACKGROUND recap (the same role the summarizer uses) is cheap and leaves the main answer intact — matching ADR 0012's "recaps stay best-effort, BACKGROUND model".

### Couple the loop directly to `StatusAnimation`

Rejected — it would make the vendor/Redis-blind L4 loop import the L9 draft surface. A tiny `TurnStreamSink` port keeps the layering: the loop sees an interface, the turn runner supplies the StatusAnimation-backed implementation.

### Finalize by promoting the draft instead of a real `sendMessage`

Rejected — Telegram drafts are ephemeral and carry no stable id; the verified contract is "finalize with a real `sendMessage` to persist". The existing `ReplyPresenter.sendText` already does exactly that and stays the sole persist path, so streaming changes only *when* the text appears, never *what* persists.

## References

- Story row + acceptance (Wave B, needs Story 10 + 12 + v1-#3): [ai-workflow-v2-plan](../specs/ai-workflow-v2-plan.md)
- The draft surface + throttle + StatusSession this streams into: [ADR 0040](0040-assistant-live-status-message.md) · [ADR 0038](0038-assistant-messenger-primitives-status-session.md) · [ADR 0012](0012-assistant-stateful-messenger-and-draft-streaming.md)
- The `attempts:1` posture the never-throw contract depends on: [ADR 0009](0009-assistant-narration-redrive.md)
- The connector port contract (one normalized round-trip): [ADR 0007](0007-provider-connector-abstraction.md)
- The L0–L11 layer model (L10 AI transport, L9 reply/egress, L4 loop, L11 background): [assistant-layered-architecture](../specs/assistant-layered-architecture.md)
- Recaps stay in the volatile tail, never the cached prefix: [ADR 0004](0004-assistant-prompt-composition-and-caching.md)
