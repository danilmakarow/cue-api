# 0048 — remove-stop-cooperative-cancellation

- **Status**: Accepted
- **Date**: 2026-06-21
- **Deciders**: @danil

## Context

[ADR 0043](0043-assistant-stop-cooperative-cancellation.md) added a cooperative mid-turn **STOP** (Story 14b): every fresh model-driven turn sent a SEPARATE real inline-button message (drafts carry no buttons), the tool loop polled a per-user/per-turn Redis flag at two cooperative checkpoints (between rounds + after each committed write), and on a STOP tap the loop halted gracefully — keeping committed writes and replying with a programmatic ledger summary (no AI call).

ADR 0043 itself flagged the cost as revisitable: *"Every fresh turn now sends + deletes one extra real message (the STOP control)… a trivial read turn still gets a transient control message. Acceptable for the control it buys; revisitable if the noise proves annoying."* Live use confirmed the noise: the per-turn STOP button — sent at turn start and deleted on turn end on **every** message — looks wrong in the chat. A button that flickers in and then vanishes on each reply is more jarring than the cooperative cancellation is worth, especially for the common trivial read/answer turn that finishes near-instantly.

This is purely the STOP half (Story 14b). The debounce / combine / queue-after half and the per-user serialization lock — Story 14a ([ADR 0042](0042-assistant-inbound-debounce-and-queue-after.md), building on [ADR 0039](0039-assistant-per-user-serialization-lock.md)) — are a separate, working subsystem and are **unaffected** by this decision.

## Decision

**Remove the cooperative STOP feature (Story 14b) entirely.** Turns now run to completion with no mid-turn cancellation surface and no STOP polling. The transient per-turn STOP button is gone; nothing replaces it (a real Undo remains a possible future feature, unchanged by this ADR). This **supersedes [ADR 0043](0043-assistant-stop-cooperative-cancellation.md)**.

What was deleted / de-wired:

- **Deleted files**: the STOP-flag store (`session/stop-flag.store.ts` + spec) and the programmatic summary builder (`orchestration/stop-summary.ts` + spec).
- **Tool loop (L4)** — both cooperative checkpoints (between rounds + after each committed write), the `stopped` `LoopOutcome` variant, the optional `stopController` loop input, the `isStopRequested`/`stoppedResult` helpers, and the programmatic-summary reply path. The loop runs to completion with no STOP polling.
- **Turn runner (L3)** — the per-turn STOP control send/remove on turn start/finish, the `StopController` wiring (`stopControllerFor`), the `StopFlagStore` injection + the turn-end flag clear, and the `stopped` branch in `finishTurn`.
- **Reply / egress (L9)** — `ReplyPresenter.sendStopControl` / `removeStopControl`, and `buildStopKeyboard` (with its `⏹ Stop` label) in `quick-reply.builder.ts`.
- **Inbound (L2) + consumer** — the `stop:` callback prefix, the `StopControlFlow` flow + its taxonomy branch, and the consumer's `handleStopControl` dispatch.
- **Facade** — `AssistantService.handleStopControl` + its params type.
- **DI + Redis + config** — the `StopFlagStore` provider, the `assistant:stop` Redis key prefix + `stopFlagKey` builder, and `ASSISTANT_STOP_FLAG_TTL_SECONDS` (Zod schema, config accessor, `.env.example`, `.env.test`, env spec fixture).
- **e2e** — the capturing connector reverted to its pre-STOP behaviour (no STOP-control framing skip / `deleteMessage` override), keeping the Wave-E reply-keyboard handling intact.
- **Tests** — every STOP unit/e2e case (stop-between-rounds, stop-after-write, stale-flag, never-throw, programmatic-summary, the inbound `stop:` classification, the consumer `stop:` routing) removed; unrelated assertions left untouched.

## Consequences

- ✅ No more transient per-turn button: every turn — especially a trivial read/answer — leaves a clean chat with no flickering control message.
- ✅ Less per-turn work: a fresh turn no longer makes the extra `sendActions` + `deleteMessage` egress calls, no longer polls Redis at two checkpoints, and no longer arms/clears a per-turn flag.
- ✅ Simpler tool loop and turn runner: one fewer `LoopOutcome` variant, one fewer loop input port, and no degrade-never-throw STOP-poll guard to reason about.
- ✅ Story 14a (debounce / combine / queue-after + the per-user lock) is **untouched and still green** — it never depended on STOP (STOP only flipped a Redis flag the loop polled), so removing STOP leaves the message-flow-control subsystem fully working.
- ⚠️ There is no longer any way to interrupt a running turn. A long multi-round turn now always runs to its natural end (round-trip ceiling, `end_turn`, `ask_user`, or terminal error). In practice turns are short and the cooperative checkpoint only ever landed between rounds / after a write anyway, so the lost capability was already coarse-grained.
- ⚠️ Partial-write semantics are unchanged in spirit: there was never a rollback subsystem, and there still isn't — a turn's committed writes simply all happen (no STOP to halt them early).

## Alternatives considered

### Keep STOP but hide the button on trivial turns (e.g. only show it once a turn passes N rounds / first write)

Rejected. It adds conditional UI timing to a feature whose whole value is being present *before* the thing you want to stop happens — a STOP that appears only after the first write can't stop that write. The complexity-for-noise trade did not improve enough to justify keeping the subsystem.

### Keep STOP but ride it on the status surface instead of a separate message

Impossible, for the same reason ADR 0043 documented: drafts carry no buttons ([ADR 0012](0012-assistant-stateful-messenger-and-draft-streaming.md) / Verified Telegram facts). A STOP button must be its own real message, which is exactly the noise being removed.

### Leave STOP in place

Rejected. Live use showed the per-turn transient button looks wrong on every message; the cooperative cancellation it bought was not worth that on the common trivial turn.

## References

- Supersedes: [ADR 0043 — assistant STOP cooperative cancellation](0043-assistant-stop-cooperative-cancellation.md) (the feature this removes)
- Unaffected sibling (debounce / queue-after + lock): [ADR 0042 — inbound debounce + queue-after](0042-assistant-inbound-debounce-and-queue-after.md), [ADR 0039 — per-user serialization lock](0039-assistant-per-user-serialization-lock.md)
- The product behaviour ADR 0043 implemented the STOP half of: [ADR 0013 — message debounce + cancellation](0013-assistant-message-debounce-and-cancellation.md)
- The `attempts:1` posture STOP degraded into: [ADR 0009 — narration re-drive](0009-assistant-narration-redrive.md)
- Layer model: [assistant-layered-architecture §the layer model](../specs/assistant-layered-architecture.md#the-layer-model)
