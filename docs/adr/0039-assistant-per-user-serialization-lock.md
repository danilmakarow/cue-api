# 0039 — assistant-per-user-serialization-lock

- **Status**: Accepted
- **Date**: 2026-06-21
- **Deciders**: @danil

## Context

This is **Story 11** of the v2 plan ([ai-workflow-v2-plan](../specs/ai-workflow-v2-plan.md)) — a dependency-free **L3 turn-lifecycle primitive**: a shared per-user mutex that serializes a single user's turns. It is the foundation two later mechanisms need:

- **Story 14 (queue-after)** must let a mid-turn message **queue after** the in-flight turn rather than race or cancel it; serializing a user's turns is the precondition.
- The **ADR-0010 `ask_user` resume** has a latent **double-resume race**: two concurrent answers to one open question can both pass the hot-key/durable claim window and re-invoke the model. The durable compare-and-set blocks double-claiming the *row*, but a per-user lock around the whole resume closes the broader two-messages race the architecture doc flagged as an open question ([assistant-layered-architecture §Open questions](../specs/assistant-layered-architecture.md#open-questions): "a per-user advisory lock around `runTurn` closes the two-messages race").

Today nothing serializes a user's concurrent inbound updates — they last-writer-win through the loop. The messenger story (ADR 0038) already notes its in-process draft throttle "does not coordinate across workers… acceptable because the Story 11 per-user lock serializes a user's turns" — so this lock is the assumed backstop there too.

Constraints that bind the design:

1. The lock is **shared across workers** (two BullMQ workers may pick up the same user's updates), so it must live in **Redis**, not in process memory.
2. A holder can **crash** mid-turn; the lock must **auto-expire** so it never deadlocks the user.
3. A long turn can outlive a short TTL; a **watchdog** must renew the lease while work is in progress.
4. Only the **true holder** may release — a naive `DEL` would let a caller delete a lock that has since expired and been re-acquired by someone else.

## Decision

**Build a `UserLockStore` (L3, `session/user-lock.store.ts`) — a Redis mutex keyed `assistant:lock:{userId}` — as a standalone primitive, and document (not yet retro-fit) its two consumers.**

- **Acquire** = `SET key token NX PX <ttlMs>`. `NX` makes acquisition mutually exclusive; the value is a unique `randomUUID` **fencing token**; `PX` auto-expires the key so a crashed holder never deadlocks. `acquire()` returns the token on success or `null` when the lock is held.
- **Release** = a **token-checked Lua compare-and-del** (`get == token ? del : 0`). Only the holder unlocks; a stale/non-holder release is a harmless no-op returning `false`. This closes the "delete someone else's re-acquired lock" race a plain `DEL` would open.
- **Renew** = a **token-checked Lua compare-and-pexpire**, driven by a **watchdog** `setInterval(userLockRenewMs)` that extends the TTL while work runs. The renew interval is **strictly below** the TTL so a live holder always re-arms before expiry; a renew that finds the lock lost **self-clears** the watchdog rather than stomping a new holder. The timer is `unref`'d (never keeps the process alive) and is **always cleared in a `finally`** (timer-leak guard, mirroring ADR 0012).
- **`runExclusive(userId, work, onBusy)`** wraps a unit of work: acquire-with-watchdog → run → **release + clear watchdog in `finally`**. When the lock is already held it returns the caller's `onBusy` sentinel **without** running `work`, leaving the queue-vs-drop-vs-reply policy to the caller (Story 14 picks queue-after).
- **New config + Redis key.** `ASSISTANT_USER_LOCK_TTL_MS` (default 30 000) and `ASSISTANT_USER_LOCK_RENEW_MS` (default 10 000) join the Zod env schema (+ `.env`/`.env.test`/`.env.example`), surfaced via `AssistantConfig.userLockTtlMs` / `userLockRenewMs`; `userLockKey()` joins `redis.constants.ts` beside the other assistant keyspaces. `UserLockStore` is registered in `assistant.module.ts`. **No new DB entity** — Story 11 is Redis-only, matching the held-conflict / status-session precedent.

This story is **additive and behaviour-preserving**: it adds the primitive + unit specs and **does not** retro-fit the call sites. Wiring `runExclusive` into `TurnRunner.runTurn` is deferred to Story 14 (its queue-after semantics, the higher-risk story, are where serialization actually changes behaviour), and into the `ask_user` resume path as part of closing the double-resume race — both called out above so the integration is unambiguous.

### Intended integration points (not retro-fitted here)

- **`TurnRunner.runTurn`** ([session/turn-runner.service.ts](../../src/modules/assistant/session/turn-runner.service.ts)) — wrap in `runExclusive(user.id, () => runTurn(state), onBusy)`; Story 14's `onBusy` enqueues the message after the current turn.
- **`ask_user` resume** (`PendingInteractionService.claimHotByUser` / `claimById` + re-invoke) — hold the lock across claim + re-invoke so two concurrent answers cannot both resume one suspended turn.

## Consequences

- ✅ A single user's turns can be **serialized** behind one shared, worker-safe mutex — the precondition for Story 14 queue-after and the fix for the `ask_user` double-resume race.
- ✅ **Crash-safe by construction**: `PX` auto-expiry means a holder that dies mid-turn never deadlocks the user; the watchdog keeps a legitimately-long turn alive.
- ✅ **Only the holder releases** (token-checked Lua) — no accidental cross-holder unlock, even across expiry + re-acquire boundaries.
- ✅ The timer is `unref`'d and cleared in `finally` — no leaked interval, no process kept alive.
- ⚠️ The lock is **advisory** — it only serializes callers that actually go through `runExclusive`/`acquire`. Until Story 14 wires it into `runTurn`, concurrent turns still race; this story ships the primitive, not the enforcement.
- ⚠️ **Clock-skew / GC-pause fencing is best-effort.** A holder paused longer than the TTL can lose the lock to a new holder while still believing it holds it; the token-checked release/renew prevent it from *unlocking* the new holder, but it cannot prevent a stale holder's in-flight write. Acceptable for serializing one user's calendar turns (low contention, short work); a true fencing-token-on-write scheme is out of scope.
- ⚠️ A new **required** env pair (`ASSISTANT_USER_LOCK_TTL_MS` / `ASSISTANT_USER_LOCK_RENEW_MS`) means every environment must supply both or boot fails (the deliberate fail-loud posture); added to all env templates in this change.

## Alternatives considered

### Plain `DEL` release (no token check)

Rejected — it lets a slow holder whose lock already expired and was re-acquired delete the **new** holder's lock, re-opening exactly the race the lock exists to close. The fencing token + Lua compare-and-del is the standard correct release.

### `GETDEL`-guard release instead of Lua

`GETDEL` returns the value and deletes atomically, but it deletes **unconditionally** — it cannot conditionally skip when the token mismatches, so it would still drop a re-acquired lock. A token compare *before* the delete is required; that is exactly what the Lua script gives atomically. Rejected for the same reason as plain `DEL`.

### In-process mutex (per-worker `Map<userId, Promise>`)

Rejected — it does not coordinate across workers, and the inbound queue can be consumed by multiple workers. A shared Redis lock is the only correct tier for cross-worker serialization (the same reason ADR 0038's in-process throttle explicitly defers to this lock).

### Postgres advisory lock (`pg_advisory_lock`)

Rejected — it ties turn serialization to a held DB connection for the turn's duration and has no built-in TTL/auto-expiry, so a crashed holder needs connection-death detection to release. Redis `SET NX PX` + watchdog gives crash-safety and TTL for free, and the assistant already owns a shared Redis client.

### Retro-fit `runTurn` now

Rejected for this story — serializing `runTurn` *changes behaviour* (a second concurrent turn now waits/queues), which is the substance of the higher-risk Story 14 (queue-after + STOP + debounce). Landing the primitive alone keeps Story 11 LOW-risk and behaviour-preserving; Story 14 owns the behavioural change behind its own ADR (0013).

## References

- Story row + wave order (Wave A, parallel with Story 10): [ai-workflow-v2-plan](../specs/ai-workflow-v2-plan.md)
- The open question this closes ("per-user advisory lock around `runTurn`"): [assistant-layered-architecture §Open questions](../specs/assistant-layered-architecture.md#open-questions)
- The messenger story that assumes this lock serializes a user's turns: [ADR 0038](0038-assistant-messenger-primitives-status-session.md)
- The `ask_user` resume whose double-resume race this guards: [ADR 0010](0010-assistant-ask-user-stateful-resume.md)
- The higher-risk Story 14 that consumes `runExclusive` (queue-after + STOP): [ADR 0013](0013-assistant-message-debounce-and-cancellation.md)
- The held-conflict / status-session Redis-only precedent: [ADR 0006](0006-assistant-schedule-context-and-conflicts.md) · [ADR 0038](0038-assistant-messenger-primitives-status-session.md)
