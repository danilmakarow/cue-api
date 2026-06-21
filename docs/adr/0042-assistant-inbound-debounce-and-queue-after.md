# 0042 — assistant-inbound-debounce-and-queue-after

- **Status**: Accepted
- **Date**: 2026-06-21
- **Deciders**: @danil

## Context

Before this wave every accepted inbound update ran a turn **immediately**: the webhook consumer dedupes → resolves the user → (for a fresh text/voice message) calls `TurnRunner.runFromMessage` synchronously on the `attempts:1` webhook job. Two problems followed from that:

- **Rapid-fire bubbles became several conflicting turns.** A single thought split across three messages ("book the dentist", "actually Tuesday", "and also the gym") produced three concurrent half-turns racing each other's writes — exactly the failure [ADR 0013](0013-assistant-message-debounce-and-cancellation.md) locked the product behaviour against.
- **The Story 11 per-user lock was built but never wired.** [`UserLockStore.runExclusive`](0039-assistant-per-user-serialization-lock.md) existed with the explicit note that its call sites were not retro-fitted; nothing serialized a user's turns, so a mid-turn message ran concurrently with the in-flight one.

This is the debounce/combine/queue-after half of Story 14 ([plan](../specs/ai-workflow-v2-plan.md) row 14). The STOP half (`stop:` control, programmatic write-ledger summary) is **deliberately deferred to 14b** and is not in this ADR. The whole change is bounded by the load-bearing invariant of the inbound pipeline: the webhook queue is **`attempts:1`** ([ADR 0009](0009-assistant-narration-redrive.md)/[ADR 0026]) — an uncaught throw drops the turn with no replay — so everything added here must **degrade-never-throw** and **never silently drop a message**.

## Decision

**Insert a per-user debounce window between the inbound pipeline and turn execution, drain it into ONE combined turn, and run that turn under the Story 11 lock with queue-after on contention.** Three pieces, all additive onto the existing L0–L11 model:

- **A Redis buffer is the source of truth for a window's messages — never the job.** `MessageBufferStore` (L3, Redis-only, matching the held-conflict / status-session / user-lock precedent) holds a per-user `LIST` keyed `assistant:debounce:buf:{userId}`. `append` RPUSHes one normalized entry in arrival order; `drain` atomically reads-and-clears via an `LRANGE`+`DEL` Lua script (so a message arriving in a naive read→delete gap can never be lost); `requeueFront` LPUSHes a drained batch back at the head for queue-after. Because the window lives in the buffer, **replacing the delayed job to re-arm can never drop a buffered message.**

- **One delayed BullMQ job per user, re-armed by remove-then-add — but queue-after arms a FRESH unique job.** `DebounceCoordinatorService` (L1/L3) owns the seam. `buffer()` (called by the consumer on an accepted simple message) appends to the buffer **first**, then arms a single delayed job on a new `assistant-debounce` queue at `now + ASSISTANT_DEBOUNCE_WINDOW_MS` with the **stable per-user jobId `debounce-{userId}`**. Each new inbound **re-arms**: it `remove`s the still-delayed job and re-`add`s it later, sliding the timer to the latest message. We chose **explicit remove-then-add over BullMQ's built-in `deduplication`/`debounce` job option** because a plain re-add with the same jobId is *ignored* by BullMQ's id-dedup (the original, earlier delay would stand — the opposite of re-arm), and because remove-then-add is trivially unit-testable against a fake queue. The remove-then-add is valid **only from the inbound path**, where the stable window job is still *delayed* (never active). The **queue-after re-poll is different**: it fires from *inside* the still-active drain job, where the stable id is the *active* job — `remove()` on an active job is a no-op and `add()` with its id is ignored, so re-using it would schedule **nothing** and the batch would stall until another inbound. Queue-after therefore arms a **fresh UNIQUE jobId (`debounce-after-{userId}-{nonce}`)** BullMQ genuinely creates, so the re-poll always runs. When a job fires, `DebounceConsumer` resolves the `User` and calls `drainAndRun(user, job.data)`, which combines the buffered texts **by concatenation in arrival order** (`\n`-joined) into one `simple_message` turn (or, for an `answer`-carrying queue-after job, re-attempts that answer).

- **Queue-after under the Story 11 lock, never cancel.** `drainAndRun` runs the combined turn inside `UserLockStore.runExclusive`. If the lock is **held** (a turn is in flight) the `onBusy` sentinel fires: the drained batch is **re-buffered at the front** and a **fresh unique drain job armed** at the short `ASSISTANT_DEBOUNCE_QUEUE_AFTER_MS` delay, so it re-polls shortly **after** the in-flight turn frees the lock — it never cancels the active turn and never runs concurrently. The lock auto-expires (its TTL is the deadlock backstop), so a crashed holder cannot wedge a user. **Voice notes still transcribe BEFORE buffering** (STT runs in the consumer exactly where it did), so a voice note coalesces by its transcript like text; a window that mixed in any voice transcript is persisted as `VOICE_TRANSCRIPT`. A **non-seed voice note's status surface is finalized as soon as it is buffered** (the drained turn only finalizes the seed entry's surface), so no later voice bubble lingers as a zombie draft.

**`ask_user` answers are never debounced — but they ARE serialized under the same lock.** An answer must not coalesce with a following message (it acknowledges a specific callback), so it is **never buffered/combined**. It does, however, run under the **same Story 11 per-user lock** as a simple-message turn: the consumer routes an `answer` flow to `DebounceCoordinatorService.runAnswerExclusive`, which runs the resume inside `UserLockStore.runExclusive` and, if the lock is held, **queues-after** by re-carrying the answer payload on a fresh unique drain job (an answer rides the job directly, since it is never combined). This makes a simple-message turn and an answer turn **mutually exclusive** for one user — an answer arriving mid-turn queues-after instead of racing the in-flight turn — while the resume's atomic `claimPending` guard still prevents a double-resume. Dedupe / linking / STT stay intact and correctly ordered ahead of the buffer.

**Degrade-never-throw everywhere.** The coordinator's `drainAndRun` wraps the turn in try/catch: a true infra fault re-buffers the batch (never drops it) rather than throwing on the `attempts:1` drain job; the buffer-`append`-then-arm order means even an arm fault leaves the message buffered for the next window. The new `assistant-debounce` queue is itself `attempts:1` for the same non-idempotency reason as the webhook queue.

## Consequences

- ✅ Rapid-fire bubbles collapse into one coherent turn (combine-by-concatenation, arrival order preserved); an "and also…" is never dropped.
- ✅ The Story 11 lock is finally wired — a single user's turns are serialized; a mid-turn message queues-after instead of racing. Different users never contend.
- ✅ Nothing is dropped under any path: the buffer holds the window across re-arms, atomic drain, queue-after re-buffer, and the never-throw fault path.
- ⚠️ Every fresh turn now incurs the ~2 s window latency (a deliberate UX trade for coalescing; the live-status draft from Story 12 already covers the wait visually).
- ⚠️ Queue-after is a **short-delay re-poll**, not a notification: a batch may re-poll once or twice before the lock frees. Bounded by `ASSISTANT_DEBOUNCE_QUEUE_AFTER_MS` ≪ the lock TTL, so it settles within one extra window at worst.
- ⚠️ **BullMQ forbids `:` in a custom job id** (`Custom Id cannot contain :`), so the drain jobId uses a hyphen separator (`debounce-{userId}`) — distinct from the colon convention every Redis *key* builder uses. The e2e suite caught this (the unit fake queue did not); documented at `redis.constants.ts:debounceJobId`.
- ⚠️ Coupled to `attempts:1`: the never-throw/re-buffer posture is what makes a single attempt safe. If the queue's attempts is ever raised, the re-buffer-on-fault path would double-run and must be reworked.

## Alternatives considered

### BullMQ's built-in `deduplication` / `debounce` job option

Rejected. A re-add with the same jobId under id-dedup is *ignored*, leaving the original (earlier) delay in place — that is coalescing without re-arm, the opposite of the required "slide the window to the latest message". The `deduplication` TTL option is geared to throttling, not a sliding window, and is harder to unit-test deterministically. Explicit remove-then-add expresses the re-arm directly.

### Cancel-and-restart on a mid-turn message

Rejected (re-confirming [ADR 0013](0013-assistant-message-debounce-and-cancellation.md)). Cancelling wastes the in-flight turn and risks half-applied writes racing the new turn. Queue-after behind the per-user lock is strictly safer and cannot drop the batch.

### Block-acquire the lock inside the drain (wait for the holder)

Rejected. Blocking the drain job on the lock ties up a BullMQ worker slot for the whole in-flight turn and risks the job's own lock-renewal interacting with the user lock's watchdog. A short-delay re-poll frees the worker immediately and leans on the lock's auto-expiry as the only deadlock backstop.

### Carry the window's messages on the BullMQ job instead of a Redis buffer

Rejected. Then re-arming (replacing the job) would have to copy the prior job's payload forward — a lost-update race on every rapid follow-up. Keeping the messages in a Redis list that the job only *points at* makes re-arm a pure scheduling operation that can never drop a message.

## References

- Product behaviour locked here: [ADR 0013 — message debounce + cancellation](0013-assistant-message-debounce-and-cancellation.md) (this ADR implements its debounce/combine/queue-after half; STOP is 14b)
- The lock this finally wires: [ADR 0039 — per-user serialization lock](0039-assistant-per-user-serialization-lock.md)
- The `attempts:1` posture everything degrades into: [ADR 0009 — narration re-drive](0009-assistant-narration-redrive.md)
- Plan + Story 14 row: [ai-workflow-v2-plan](../specs/ai-workflow-v2-plan.md)
- Layer model: [assistant-layered-architecture §the layer model](../specs/assistant-layered-architecture.md#the-layer-model)
