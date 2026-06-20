# 0033 — assistant-conflict-layer

- **Status**: Accepted
- **Date**: 2026-06-20
- **Deciders**: @danil

## Context

The deterministic held-conflict path (ADR 0006) was fused into the orchestrator (`assistant.service.ts`). Three concerns lived there inline: the `heldConflictKey` Redis state (the `redis.set(...)` stash in `holdAndAsk` and the `redis.getdel(...)` burn in `handleCallback`), the no-model replay (`executeHeldBatch` / `executeHeldAction` / `executeHeldRecurringEdit`, plus the pure helpers `toCreateRecurrenceDto` and `heldActionLabel`), and the public `handleCallback` body that wires them together (acknowledge → load+burn → confirm-execute / cancel-nothing → reply+persist). `Redis` and `TaskService` were injected into the god-service almost solely for this path.

This is the L8 conflict layer the [layered architecture](../specs/assistant-layered-architecture.md#the-layer-model) names: held write → **deterministic** execute on tap, **NO model**. It is **safety-critical** — the [4 ADR-0006 cases are the hard floor](../specs/assistant-layered-architecture.md#scope-the-three-public-methods-stay-the-contract) (held-write-not-reinvoked, confirm-writes, cancel-writes-nothing, partial-batch-no-rethrow), and the held state is deliberately Redis-only ([ADR 0006](0006-assistant-schedule-context-and-conflicts.md)): a stale overlap must *expire*, not resurrect, because the calendar may have moved. Leaving the replay fused in the orchestrator means the keystone tool-loop lift still drags `Redis` + `TaskService` + the replay along, and the "deterministic, no model" guarantee has no single isolated home to point at and audit.

This is **migration step 4** of the assistant layering plan ([assistant-layered-architecture §migration plan](../specs/assistant-layered-architecture.md#migration-plan-incremental-test-safe)), following the egress lift (step 3, [ADR 0032](0032-assistant-reply-egress-layer.md)). Like the steps before it, it is a **behaviour-preserving lift**: code moves verbatim, no logic changes.

## Decision

Introduce one isolated L8 conflict layer — `conflict/held-conflict.store.ts` (`HeldConflictStore`) for the Redis state and `conflict/conflict-resolver.service.ts` (`ConflictResolverService`) for the deterministic replay — and re-point the orchestrator to delegate to both.

- **`HeldConflictStore` owns the `heldConflictKey` keyspace.** It injects `Redis` + `AssistantConfig` and exposes `stash(token, batch)` (the former `holdAndAsk` `redis.set(... 'EX', heldConflictTtlSeconds)`) and `claim(token)` (the former `handleCallback` `redis.getdel` + `JSON.parse`, returning `null` when the key already expired/was consumed). Burning-on-read keeps a held batch replayable at most once. It is the **only** caller of `heldConflictKey` outside `redis.constants.ts`.
- **`ConflictResolverService` owns the deterministic replay.** It injects `TaskService` (L7), `HeldConflictStore`, `ReplyPresenter` (the L9 sender, [ADR 0032](0032-assistant-reply-egress-layer.md)), and `ConversationStore` (L3 persist). Its method bodies are the verbatim former orchestrator bodies: `executeHeldBatch` / `executeHeldAction` / `executeHeldRecurringEdit` / `toCreateRecurrenceDto` / `heldActionLabel`, plus the whole `handleCallback` body (acknowledge → `claim` → on cancel send "nothing changed" + persist → on confirm `executeHeldBatch` + send + persist). **No `ai`/model collaborator is injected** — the resolver structurally *cannot* re-invoke the model.
- **The orchestrator delegates.** `AssistantService.handleCallback` keeps its public signature, mints/threads the correlation id, get-or-creates the conversation (unchanged ordering), and hands the rest to `this.conflictResolver.handleCallback(user, conversation, params, correlationId)`. In the loop path, `holdAndAsk` now calls `this.heldConflictStore.stash(...)` instead of `redis.set`. The orchestrator's own `buildHeldPrompt` (still part of the L5 loop, lifted in the next step) reuses the resolver's now-public `heldActionLabel` so the label wording stays single-sourced.
- **The `Redis` and `TaskService` injections are removed from `AssistantService`.** With the replay and the held state gone, the orchestrator no longer touches Redis or the task service directly; both providers are wired in `assistant.module.ts` and injected into the new layer instead.

**This step is behaviour-preserving.** Every Redis call hits the same key with the same TTL/args; every `TaskService.create` / `update` / `splitSeries` runs with the identical arguments and order; every reply is the same string sent through the same `ReplyPresenter`; the partial-batch per-action try/catch (no rethrow, so BullMQ never retries against the burned token) is moved intact. The orchestrator spec keeps **every** existing assertion: the harness now wraps a **real** `HeldConflictStore` (around the same `redis` + `config` mocks) and a **real** `ConflictResolverService` (around the same `taskService` + `replyPresenter` + `conversationStore`), mirroring how steps 2/3 wrapped real stores/presenter around the same mocks — so every `redis.set` / `redis.getdel`, `taskService.*`, and `vendor.*` expectation observes the identical call through the new layer. No assertion was changed or deleted; only the constructor wiring in the test setup was updated.

## Consequences

- ✅ **The ADR-0006 path is isolated and auditable.** The deterministic replay and its Redis state live in one directory (`conflict/`) with no model collaborator in sight — "deterministic, no model" is now a structural property (the resolver has no `ai` to call) rather than a convention spread across the god-service.
- ✅ **One held-state chokepoint.** `heldConflictKey` has exactly one caller outside `redis.constants.ts` (`HeldConflictStore`), verifiable by grep — the keystone tool-loop lift can move without dragging the Redis stash/burn.
- ✅ **The orchestrator sheds two heavy injections.** `Redis` and `TaskService` leave the `AssistantService` constructor; it no longer reaches the data/cache layers directly for the conflict path.
- ✅ **Behaviour-preserving lift.** The 4 ADR-0006 cases stay green with their assertions untouched (`handleCallback` confirm/cancel, the recurring create/edit replay, and the partial-batch no-rethrow), and the full suite is green (434 tests) — only the test's constructor wiring changed.
- ⚠️ **`heldActionLabel` is shared upward by one caller.** The resolver exposes it `public` so the orchestrator's `buildHeldPrompt` (still on the L5 loop side until the next step) reuses the identical labelling. This is a deliberate, single-line coupling that keeps the held wording single-sourced; it dissolves when `buildHeldPrompt` lifts into the tool-loop layer (step 5) and can co-locate or re-import the label.
- ⚠️ **Conversation get-or-create stays in the orchestrator.** `handleCallback` still creates the conversation before delegating (preserving the prior ordering and the harmless get-or-create even on the `!token` early-return) and passes it in, rather than the resolver owning that read. Keeping it in the public entry mirrors the other public methods and avoids handing the resolver an extra store solely for the early-return path.

## Alternatives considered

### Fold the Redis state into the resolver instead of a separate store

Have `ConflictResolverService` call `redis.set`/`redis.getdel` directly and drop `HeldConflictStore`. Rejected: the held-state keyspace + TTL is its own concern (the L8 spec lists `held-conflict.store.ts` *and* `conflict-resolver.service.ts` as two files), and a dedicated store keeps `heldConflictKey` to a single owner — mirroring the session-store split (step 2) and keeping the resolver about *replay*, not *storage*. The store is also the natural seam if held state ever needs a different backing or instrumentation.

### Move `buildHeldPrompt` into the conflict layer too

`buildHeldPrompt` is in the FROM set for this step, but it is structurally the **loop** side (called only from `runToolLoop` when a round yields held conflicts, *before* anything is stashed), not the deterministic tap-replay side. Moving it here would split the loop across two layers prematurely and force rewriting the loop's wiring twice. Rejected for this step: `buildHeldPrompt` stays in the orchestrator and is lifted with the rest of `runToolLoop` in the keystone step 5; for now it reuses the resolver's public `heldActionLabel` so no wording is duplicated.

## References

- The deterministic conflict rule this layer must not break (the 4 cases): [ADR 0006](0006-assistant-schedule-context-and-conflicts.md)
- The prior lifts in this sequence — session stores (step 2) and reply/egress (step 3): [ADR 0031](0031-assistant-session-stores.md) · [ADR 0032](0032-assistant-reply-egress-layer.md)
- The L9 presenter this layer sends through: [ADR 0032](0032-assistant-reply-egress-layer.md)
- The router that keeps the `confirm:`/`cancel:` callback prefixes disjoint from `ask:`: [ADR 0030](0030-assistant-inbound-flow-router-turn-runner.md)
- The layered home (`conflict/held-conflict.store.ts` + `conflict/conflict-resolver.service.ts`) and why the two suspend paths are non-conflatable: [assistant-layered-architecture §layer model / §the ADR-0006 constraint](../specs/assistant-layered-architecture.md#the-layer-model)
