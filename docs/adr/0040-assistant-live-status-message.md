# 0040 — assistant-live-status-message

- **Status**: Accepted
- **Date**: 2026-06-21
- **Deciders**: @danil

## Context

This is **Story 12** of the v2 plan ([ai-workflow-v2-plan](../specs/ai-workflow-v2-plan.md)) — the **first wave-B story that wires the Wave-A primitives into the LIVE turn path**. Wave A shipped the inert building blocks ([ADR 0038](0038-assistant-messenger-primitives-status-session.md) / [ADR 0012](0012-assistant-stateful-messenger-and-draft-streaming.md)): the `sendMessageDraft` / `editMessageText` / `sendChatAction` connector methods, the central **`DraftThrottle`** (~2–5/s, the undocumented-rate-limit chokepoint), and the Redis-backed idempotent **`StatusSessionStore`**. None of them touched the turn yet.

Today a turn shows **nothing** until the full reply lands — a multi-second silence on every message, worse on a voice note that must transcribe first. The plan's verified Telegram facts give us the surface to fix it:

- **`sendMessageDraft`** with **empty text** renders Telegram's native **"Thinking…"** shimmer; **re-calling with the same `draft_id` animates the transition client-side** (that re-call *is* the update mechanism). Drafts are **private-chat only** and **ephemeral (30 s)** — the real reply (`ReplyPresenter.sendText`) is what persists.
- The draft-call rate limit is **undocumented** → every draft update **must** route through the Wave-A `DraftThrottle`; a per-token / per-tick tight loop is forbidden.

Constraints that bind the design:

1. **Degrade, never throw into the turn.** The webhook queue is `attempts:1` — an uncaught throw drops the turn with **no retry**. Every Redis/draft/status call in the status surface must be wrapped so a fault skips the surface and the turn still answers.
2. **ALL draft updates through the one throttle**; **ONE `StatusSession` + ONE throttle + at most ONE `setInterval` per turn** (Wave-A review note).
3. The animation `setInterval` **must be cleared in a `finally` on every turn-exit path** — success, AI error, `ask_user` suspend, held conflict — or it leaks.
4. The **voice path** transcribes *before* classification (in `webhook.consumer`), so the "Listening…" state must appear there, then transition seamlessly into the normal loading animation owned by the turn runner.

## Decision

**Add an L9 `StatusAnimatorService` that produces a per-turn `StatusAnimation` handle, and wire it into the turn lifecycle (L3 `TurnRunnerService`) and the voice path (L1 `webhook.consumer`). All status I/O degrades never-throw; all draft frames route through the Wave-A throttle.**

- **`status-phrases.ts` (pure)** — the Appendix-A vocabulary: 30 evocative words × `en`/`uk`/`ru`, the localized voice line, `resolveStatusLocale(language_code)` (primary-subtag match, default `en`), and `nextLoadingWord(locale, previous, random)` which **never returns the immediately-previous word** (no back-to-back repeat). Dependency-free so the word-cycle + locale rules are unit-tested in isolation.
- **`StatusAnimation` (per-turn handle)** — owns **exactly one `DraftThrottle`** and **at most one pair of timers** (a `dotTimer` and a `wordTimer`) for the turn. `open()` opens the idempotent `StatusSession` and posts the initial surface: an **empty-text draft ("Thinking…")** for a private chat, or **a single static line** otherwise. `showVoiceListening()` shows the localized "Listening to your beautiful voice" line (+ a `record_voice` chat action) before STT. `startLoading()` advances the session to `Working`, renders the first `<word>.` frame, then arms a **dot tick every `statusDotIntervalMs` (~500 ms)** cycling `.`→`..`→`...` and a **word swap every `statusWordIntervalMs` (~5 s)**; every frame is submitted through the throttle. `finalize()` clears both timers, cancels the throttle's pending flush, and clears the `StatusSession`.
- **One surface per turn, keyed by `correlationId`.** The animation's `turnId` **is the turn's `correlationId`**, and the non-zero `draft_id` is a **deterministic hash of it**. So the voice notice posted by the consumer *before* transcription and the loading loop opened by the turn runner *after* it target the **same** idempotent `StatusSession` and the **same** draft — the voice line transitions into the cycling words with no second surface. The consumer's voice handle arms **no timer** (single frame), so it never leaks even though the turn runner owns the eventual `finalize`; on the STT-failure early-return the consumer finalizes its own handle to clear the Redis session.
- **Non-private degrade.** Drafts are private-only, so a group/channel turn gets a **single static line** via `editMessageText` and **no animation loop** (no per-second editing of a real message under the ~1 msg/s budget).
- **Finalization preserves the core contract.** The real reply still goes through `ReplyPresenter.sendText` unchanged — it supersedes the ephemeral draft. The animator only tears down **its own** timers + Redis handle; it never deletes a message and never changes **what** the reply says.
- **New config.** `ASSISTANT_STATUS_DOT_INTERVAL_MS` (default 500) and `ASSISTANT_STATUS_WORD_INTERVAL_MS` (default 5000) join the Zod env schema (+ `.env.example` / `.env.test`), surfaced via `AssistantConfig`. `language_code` is threaded from the Telegram wire type → `NormalizedInboundMessage.languageCode` → the turn path. `StatusAnimatorService` is registered in `assistant.module.ts`.

This story is **behaviour-preserving for the core contract**: the turn still answers, writes still happen, and the 4 ADR-0006 conflict cases + `ask_user` suspend/resume + correction re-drive all stay green. The existing turn-runner / consumer specs gained an inert animator stub (no assertion weakened); new observed vendor traffic is covered by dedicated `status-phrases` + `status-animator` specs.

## Consequences

- ✅ **Instant feedback** — within ~1 s a private chat shows Telegram's native "Thinking…", then animated evocative words; a voice note shows "Listening to your beautiful voice" the moment it arrives, before STT even returns.
- ✅ **One surface, seamless voice→loading transition** — keying the `StatusSession` + `draft_id` off the `correlationId` means the consumer's voice notice and the runner's loading loop are the same draft, idempotently (safe even if `attempts` is ever raised above 1).
- ✅ **No interval leak** — `finalize()` clears both timers in the turn runner's `finally`, reached on every exit (reply, AI error, `ask_user` suspend, held conflict).
- ✅ **Throttle-safe** — the 2/s dot tick + 0.2/s word swap sit well under the ~2–5/s cap; both route through the one Wave-A `DraftThrottle` (coalescing, so a draft frame is never queued behind a stale one).
- ✅ **Degrade-never-throw** — every Redis/draft/status call is wrapped; a faulting status surface logs at `debug` and the turn answers regardless.
- ⚠️ **Drafts are ephemeral (30 s).** A pathologically long turn could outlive the draft TTL before the real reply lands; the keep-alive dot tick re-posts within the window, and the persisted reply is the durable artefact, so the worst case is a momentarily-blank status — never a lost answer.
- ⚠️ **`language_code` is best-effort.** Telegram only sends it when the client reports it; absent ⇒ the English vocabulary. No per-user locale override yet (that would belong with Story 18 persona).
- ⚠️ **The dot/word timers are per-process, not coordinated across workers.** As ADR 0038 notes, the per-user serialization lock (Story 11) is the backstop that keeps one user's turns from running two animations at once; until it is wired into `runTurn` (Story 14) two truly-concurrent turns for one user would each animate — harmless (same draft id coalesces) but redundant.

## Alternatives considered

### Animate by editing a real message (`editMessageText`) instead of a draft

Rejected for private chats — the ~1 msg/s-per-chat edit budget makes a sub-second dot animation impossible (HTTP 429), and the draft's native client-side animation is smoother and free. Kept **only** as the non-private degraded path (a single static line, no loop).

### Start the loading loop in the consumer for voice (one handle end-to-end)

Rejected — the consumer runs *before* the turn runner mints the loop and owns the `finally`. Threading a live `StatusAnimation` (with an armed `setInterval`) through the BullMQ-shaped `runFromMessage` seam would risk a leaked timer if the hand-off ever short-circuits. Instead the consumer posts a **single** voice frame (no timer) and the turn runner opens the loop on the **same** idempotent session — one animation loop, owned in one place, finalized in one `finally`.

### Per-turn throttle vs. a shared L9 throttle

Rejected a shared singleton throttle — a single coalescing limiter shared across concurrent turns would let one turn's frames starve another's (the cap is global). One `DraftThrottle` **per `StatusAnimation`** (per turn) gives each turn its own cap, matching the Wave-A "one instance per live status/stream" intent; cross-worker coordination is the per-user lock's job, not the throttle's.

### Put the cycling-word logic in the animator service

Rejected — keeping the vocabulary + locale + no-repeat selection in a **pure** `status-phrases.ts` module makes the word-cycle and locale rules testable without timers, Redis, or the vendor, and lets Story 13's recaps reuse the locale resolver. The animator stays thin: timers + throttle + degrade-wrapping.

## References

- Story row + acceptance + Appendix A vocabulary (Wave B, needs Story 10): [ai-workflow-v2-plan](../specs/ai-workflow-v2-plan.md)
- The Wave-A primitives this wires in (draft/edit/chat-action, throttle, `StatusSession`): [ADR 0038](0038-assistant-messenger-primitives-status-session.md) · [ADR 0012](0012-assistant-stateful-messenger-and-draft-streaming.md)
- The per-user lock that backstops one-animation-per-user across workers: [ADR 0039](0039-assistant-per-user-serialization-lock.md)
- The L0–L11 layer model (L9 reply/egress, L1 ingress, L3 turn lifecycle): [assistant-layered-architecture](../specs/assistant-layered-architecture.md)
- The next story that streams the reply *into* the same draft surface this establishes: [ADR 0013](0013-assistant-message-debounce-and-cancellation.md) (debounce/STOP) · Story 13 (response streaming)
