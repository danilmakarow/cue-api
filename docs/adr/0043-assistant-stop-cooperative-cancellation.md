# 0043 — assistant-stop-cooperative-cancellation

- **Status**: Accepted
- **Date**: 2026-06-21
- **Deciders**: @danil

## Context

[ADR 0013](0013-assistant-message-debounce-and-cancellation.md) locked the product behaviour for in-flight message control: a user must be able to **STOP** a running turn, and STOP must **keep** whatever was already committed (no rollback) and reply with a **programmatic** summary of what was done — never an AI-generated one. Story 14a ([ADR 0042](0042-assistant-inbound-debounce-and-queue-after.md)) shipped the debounce / combine / queue-after half and wired the Story 11 per-user lock. This ADR is the **STOP half** (Story 14b) — the highest behavioural-risk slice of the wave.

Three realities bind the design:

- **The webhook queue is `attempts:1`** ([ADR 0009](0009-assistant-narration-redrive.md)/ADR 0026): an uncaught throw drops the turn with no replay, and committed calendar writes are **not idempotent**. So everything STOP adds must **degrade-never-throw** into the turn path, and STOP must **never roll back** a write that already happened.
- **The model call inside a round cannot be interrupted.** The only safe interruption points are **between rounds** and **after a committed write** — anywhere else would either abandon an in-flight model call or tear a `tool_use`/`tool_result` pair.
- **Drafts carry no buttons** (Verified Telegram facts, [ADR 0012](0012-assistant-stateful-messenger-and-draft-streaming.md)). The live-status surface is a draft, so STOP **cannot ride the status draft** — it must be its own real message.

## Decision

**Add a cooperative STOP: a separate real STOP-button message per turn, a per-user/per-turn Redis flag the tool loop polls at safe checkpoints, and a graceful halt that keeps committed writes and replies with a programmatic ledger summary (no AI call).** Five additive pieces onto the existing L0–L11 model:

- **A separate real STOP control (L9).** The turn runner sends a real message carrying one inline button (`ReplyPresenter.sendStopControl`) at the start of every fresh model-driven turn — its callback data is `stop:<turnId>` (the turn's `correlationId`). It rides its OWN message because the status draft carries no buttons. The returned vendor message id is captured and the control is **removed on every turn-exit path** (`removeStopControl` → `deleteMessage`) in the same `finally` that finalizes the status animation. An `ask_user` resume sends no control (its answer is short and it carries no in-flight loop to stop).

- **A turn-scoped STOP flag (L3, Redis-only).** `StopFlagStore` owns the `assistant:stop:{userId}:{turnId}` keyspace (matching the held-conflict / user-lock / status-session Redis-only precedent). Keying by **both** the user id and the turn id is what makes the flag **turn-scoped**: a stale flag from a previous turn can never abort a fresh turn (a fresh turn has a new `correlationId`), and the turn clears its own key on exit. Every method **degrades never-throw** — a Redis fault reads as "no STOP" so a transient blip never aborts a turn the user did not stop.

- **A deterministic STOP-callback handler (L2 → facade, NO model).** The inbound router classifies a `stop:`-prefixed callback into a new `StopControlFlow` (disjoint at the wire level from `confirm:`/`cancel:`/`ask:`). The consumer dispatches it to `AssistantService.handleStopControl`, which acknowledges the tap and **arms** the flag — it never touches the in-flight turn directly. Crucially it runs **outside** the per-user lock, so a STOP reaches the lock-holding running turn instead of queuing behind it; it only flips a Redis flag the running turn cooperatively honours, so it can never corrupt the debounce queue or the running turn (integration with 14a).

- **Cooperative checkpoints in the loop (L4).** `ToolLoopService` polls a `StopController` port (loop stays L3/Redis-blind, mirroring the `TurnStreamSink` port) at two points: **between rounds** (top of the round loop, before the next model call) and **after each committed write** (right after the write ledger increments). On STOP it **stops gracefully** — keeping every committed write (no rollback), recording the round's audit first so the just-committed write is in the ledger, skipping the rest of the round, and returning a new `stopped` `LoopOutcome`. Held-conflict precedence is preserved: a held conflict in the same round still resolves deterministically first. The poll is guarded so a controller fault is swallowed as "no STOP" — the loop **never throws** (`attempts:1`).

- **A programmatic summary (L4, no AI).** `buildStopSummary(rounds, committedWrites)` scans the round/step ledger for committed writes (a write-tool step that did not error and was not held) and lists them in arrival order — e.g. *"Stopped. Before stopping I created "Dentist" and deleted "Standup"."*, or *"Stopped — nothing was changed."* when nothing committed. The turn runner sends + persists it like a reply (no false-success guard — it is a deterministic record, never a model claim) and fires the post-turn background jobs.

## Consequences

- ✅ STOP is honest and instant ("here's what I managed to do"), with **no rollback subsystem** — consistent with `attempts:1` and ADR 0013.
- ✅ The flag is **turn-scoped**, so a stale STOP from a previous turn can never abort a fresh one; the turn also clears its own key on exit (belt-and-braces).
- ✅ STOP **integrates cleanly with 14a**: it runs outside the lock and only flips a flag, so it stops the running turn without corrupting the debounce queue or queue-after.
- ✅ Everything degrades never-throw: the flag store, the loop's checkpoint poll, and the control send/remove all swallow their own faults, so a STOP-flag or control fault never breaks the `attempts:1` turn.
- ⚠️ **The checkpoint only fires between rounds / after a committed write** — a long single model call cannot be interrupted instantly (the same limitation ADR 0013 documented). STOP lands at the next safe point.
- ℹ️ The after-write checkpoint (#2) can let STOP pre-empt a would-be **held** conflict later in the same round, skipping straight to the programmatic summary. This is safe and intended: a held conflict holds *nothing* (default-deny — no write committed for it), so pre-empting it loses no committed work; the user simply gets the honest "here's what I managed to do" for the writes that did commit, and can re-issue the rest.
- ⚠️ **Every fresh turn now sends + deletes one extra real message** (the STOP control). It is removed on turn end, but a trivial read turn still gets a transient control message. Acceptable for the control it buys; revisitable if the noise proves annoying.
- ⚠️ **STOP keeps partial writes** (no rollback) — a real Undo remains a separate future feature.
- ⚠️ Coupled to `attempts:1`: the keep-writes + programmatic-summary semantics assume a single attempt. If the queue's attempts is ever raised, STOP semantics need rework alongside the rest of the inbound posture.

## Alternatives considered

### Hard cancellation (abort the in-flight model call / kill the turn)

Rejected. There is no safe way to abort mid-round without tearing a `tool_use`/`tool_result` pair or abandoning committed-but-unsummarized writes, and a thrown abort on an `attempts:1` job would drop the turn with no user-facing reply. A cooperative checkpoint that the loop polls is the only safe interruption.

### Rollback on STOP (compensating deletes of this turn's writes)

Rejected (re-confirming ADR 0013). Distinguishing *this turn's* rows from pre-existing ones is an error-prone subsystem, and the writes are non-idempotent under `attempts:1`. Keep + summarize matches the reality.

### AI-generated STOP summary

Rejected (re-confirming ADR 0013). Adding latency and a model call to a *cancel* is backwards; the round/step ledger already holds everything for a deterministic, instant summary.

### Riding the STOP button on the status draft

Impossible — drafts carry no buttons (ADR 0012 / Verified Telegram facts). STOP must be a separate real message, removed on turn end.

### A single per-user STOP flag (not keyed by turn)

Rejected. A user-only key lets a STOP tapped on an old, already-finished turn abort the user's *next* turn (a stale-flag abort). Keying by `userId + turnId` scopes the flag to exactly the turn its control belonged to; the turn also clears its own key on exit.

### Routing the STOP tap through the per-user lock

Rejected. The running turn already holds the lock, so a lock-respecting STOP handler would queue *behind* the very turn it must interrupt. STOP must run outside the lock and only flip a flag the running turn polls.

## References

- Product behaviour locked here: [ADR 0013 — message debounce + cancellation](0013-assistant-message-debounce-and-cancellation.md) (this ADR implements its STOP half; 14a implemented the debounce/combine/queue-after half)
- The debounce / queue-after half + lock wiring this builds on: [ADR 0042 — inbound debounce + queue-after](0042-assistant-inbound-debounce-and-queue-after.md)
- The lock STOP runs outside: [ADR 0039 — per-user serialization lock](0039-assistant-per-user-serialization-lock.md)
- The `attempts:1` posture everything degrades into: [ADR 0009 — narration re-drive](0009-assistant-narration-redrive.md)
- The draft surface that can't carry the STOP button: [ADR 0012 — stateful messenger + draft streaming](0012-assistant-stateful-messenger-and-draft-streaming.md)
- Plan + Story 14 row: [ai-workflow-v2-plan](../specs/ai-workflow-v2-plan.md)
- Layer model: [assistant-layered-architecture §the layer model](../specs/assistant-layered-architecture.md#the-layer-model)
