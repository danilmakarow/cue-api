# 0034 — assistant-tool-loop-orchestration-layer

- **Status**: Accepted
- **Date**: 2026-06-20
- **Deciders**: @danil

## Context

The agent loop — the bounded "call the model → dispatch tools → feed results back → re-invoke" cycle that is the heart of the assistant — was fused into the orchestrator (`assistant.service.ts`) as the private `runToolLoop`, together with its pure helpers (`classifyTerminalTurn`, `terminalReplyText`, `buildNarrationAuditRound`, `isFalseSuccessReply`, `buildHeldPrompt`) and the loop-only module constants (`ROUNDTRIP_CEILING_REPLY`, `TRUNCATED_REPLY`, `REFUSAL_REPLY`, `SCHEDULE_CAP_TOOL_RESULT`, `CORRECTIVE_NUDGE`, `MUTATION_CLAIM_PATTERN`, `CLAIM_VETO_PATTERN`) and types (`AskSuspension`, `LoopOutcome`, `TerminalClassification`, `ToolLoopResult`, `CollectedHeldConflict`). The `AiConnector`, `ContextBuilderService`, and `ToolDispatcherService` were injected into the god-service almost solely to feed this loop.

This is the **L4 tool-loop layer** the [layered architecture](../specs/assistant-layered-architecture.md#the-layer-model) names — and the **keystone** of the lift: everything routes *through* it, and it is the largest single block of logic in the service. It is already the cleanest layer to isolate because it is **vendor / redis / ORM blind**: it speaks only to the L10 `AiConnector`, the L6 `ContextBuilderService`, the L5 `ToolDispatcherService`, and (after steps 2–4) the L8 conflict resolver for one label. Nothing in the loop touches Telegram, Postgres, or Redis directly — the persist/send tail lives in the orchestrator's `finishTurn`, which stays.

This is **migration step 5** of the assistant layering plan ([assistant-layered-architecture §migration plan](../specs/assistant-layered-architecture.md#migration-plan-incremental-test-safe)), following the conflict lift (step 4, [ADR 0033](0033-assistant-conflict-layer.md)). It is the **highest-risk** step — it moves the most code and the most subtle control flow (the ADR-0009 narration re-drive, the ADR-0010 `ask_user` suspension, the held-batch collection, the stop-reason branching) — so it is executed as a **PURE, BYTE-IDENTICAL relocation**: method bodies move verbatim, no logic changes.

## Decision

Introduce one isolated L4 layer — `orchestration/tool-loop.service.ts` (`ToolLoopService`) — and re-point the orchestrator's two loop call sites to delegate to it.

- **`ToolLoopService.run(state)` owns the agent loop.** The former `runToolLoop` body moves verbatim. Its prior positional signature (`user, conversationId, currentMessageText, correlationId, resumeRounds?`) is wrapped in a single `ToolLoopState` parameter object (`run(state): Promise<ToolLoopResult>`); the destructured locals at the top of the method are the only added lines, so the loop body below them is unchanged. The `LoopOutcome` union (`reply | held | ask | unresolved | error`) and the `ToolLoopResult` / `AskSuspension` shapes are moved and **exported** so the orchestrator's `finishTurn` / `suspendAndAsk` consume them across the layer boundary.
- **The pure helpers move with it.** `classifyTerminalTurn`, `terminalReplyText`, `buildNarrationAuditRound`, `buildHeldPrompt`, and the loop-only constants/patterns relocate verbatim. `isFalseSuccessReply` also moves but is exposed `public` (mirroring ADR 0033's `heldActionLabel`): the orchestrator's post-loop false-success guard in `finishTurn` calls `this.toolLoop.isFalseSuccessReply(...)` so the `MUTATION_CLAIM_PATTERN` / `CLAIM_VETO_PATTERN` detection is single-sourced and not duplicated across layers.
- **`ToolLoopService` injects L10/L6/L5 only.** `AiConnector` (`ACTIVE_AI_CONNECTOR`), `AssistantConfig`, `ContextBuilderService`, and `ToolDispatcherService` — plus `ConflictResolverService` purely so `buildHeldPrompt` reuses the resolver's public `heldActionLabel` (the deliberate single-line coupling ADR 0033 flagged dissolves here, now co-located in the loop layer). No vendor, redis, or ORM collaborator is injected — the loop is structurally blind to them.
- **The orchestrator delegates.** `AssistantService` drops the `AiConnector`, `AssistantConfig`, `ContextBuilderService`, and `ToolDispatcherService` injections (they belonged to the loop) and gains `ToolLoopService`. Both former `this.runToolLoop(...)` call sites — in `handleText` (fresh turn) and `resumeAnswer` (ADR-0010 resume, passing `resumeRounds`) — become `this.toolLoop.run({...})`. The post-loop tail (`finishTurn`, `holdAndAsk`, `suspendAndAsk`, the background-job trigger) stays in the orchestrator unchanged.

**This step is behaviour-preserving.** Every `ai.complete` call carries the identical request (system, messages, tools, toolRounds, toolChoice, features, traceId); the schedule-fetch cap, write accounting, narration re-drive (`tool_choice:'any'` for exactly the next round), `ask_user` suspension wire-invariant, and held-batch collection are moved intact; every reply string is byte-identical. The orchestrator spec keeps **every** existing assertion: the harness now wraps a **real** `ToolLoopService` around the same `ai` / `config` / `contextBuilder` / `toolDispatcher` / `conflictResolver` mocks — mirroring how steps 2–4 wrapped real stores / presenter / resolver around the same mocks — so every `ai.complete`, `contextBuilder.build`, and `toolDispatcher.dispatch` expectation observes the identical call through the new layer. No assertion was changed or deleted; only the constructor wiring in the test setup was updated.

## Consequences

- ✅ **The keystone is isolated.** The agent loop lives in one file with a typed `run(state)` entry and a `ToolLoopResult` exit — the orchestrator no longer owns "call the model"; it owns only "persist the turn, run the loop, present the outcome".
- ✅ **The orchestrator sheds three injections.** `AiConnector`, `ContextBuilderService`, and `ToolDispatcherService` leave the `AssistantService` constructor (down to alert + the loop + the post-loop collaborators). With ADR 0033's Redis/TaskService removal, the god-service no longer reaches the model, the context builder, or the dispatcher directly.
- ✅ **"Vendor/redis/ORM-blind" is now structural.** `ToolLoopService` has no vendor, redis, or ORM collaborator to call — the loop *cannot* send a Telegram message or touch Postgres; it returns a `LoopOutcome` the orchestrator presents.
- ✅ **Behaviour-preserving lift.** The full assistant suite is green (154 assistant tests; 431 across the non-`task-occurrence` suites), with every assertion untouched — the relocation reads as move, not rewrite (the loop body is byte-identical, ~697 lines out of the service ≈ the loop block now in the new file).
- ⚠️ **`isFalseSuccessReply` is shared upward by one caller.** The loop exposes it `public` so `finishTurn`'s post-loop guard reuses the identical detection. This mirrors ADR 0033's `heldActionLabel` coupling — a deliberate, single-line cross-layer reuse that keeps the false-success patterns single-sourced rather than duplicated in the orchestrator.
- ⚠️ **The `run(state)` parameter object is a (minimal) signature change.** The positional args became a `ToolLoopState`; this is the only non-verbatim edit to the method, and it touches only the two call sites (both updated) — no behaviour rides on it.

## Alternatives considered

### Keep the positional `runToolLoop` signature on the new service

Move the method verbatim including its 5 positional parameters. Rejected: a 5-arg method (with an optional trailing `resumeRounds`) is the exact shape that invites a mis-ordered call across a module boundary, and the spec/ADR plan names `run(state)` as the L4 entry. The `ToolLoopState` object is self-documenting at both call sites (`handleText`'s fresh turn vs `resumeAnswer`'s `resumeRounds`) and is the only deviation from a byte-identical move.

### Move `finishTurn`'s false-success guard into the loop too

Fold the post-loop `isFalseSuccessReply` masking into `ToolLoopService` so the orchestrator never re-checks. Rejected for this step: `finishTurn` is the **presentation** tail (it also persists + sends + fires background jobs), structurally the orchestrator's job, not the loop's — and the guard runs *after* the loop returns a `reply` outcome, on the orchestrator side of the boundary. Exposing `isFalseSuccessReply` `public` keeps the detection single-sourced without prematurely dragging the persist/send tail into the loop layer.

## References

- The narration re-drive this loop owns (the `unresolved` / corrective-nudge path): [ADR 0009](0009-assistant-narration-redrive.md)
- The `ask_user` suspension wire-invariant the loop preserves: [ADR 0010](0010-assistant-ask-user-stateful-resume.md)
- The deterministic conflict path whose `heldActionLabel` the loop reuses for `buildHeldPrompt`: [ADR 0006](0006-assistant-schedule-context-and-conflicts.md) · [ADR 0033](0033-assistant-conflict-layer.md)
- The prior lifts in this sequence — session stores (step 2), reply/egress (step 3), conflict (step 4): [ADR 0031](0031-assistant-session-stores.md) · [ADR 0032](0032-assistant-reply-egress-layer.md) · [ADR 0033](0033-assistant-conflict-layer.md)
- The router that seeds a turn and the convergence point the loop is: [ADR 0030](0030-assistant-inbound-flow-router-turn-runner.md)
- The layered home (`orchestration/tool-loop.service.ts`) and the migration step that lifts it: [assistant-layered-architecture §layer model / §migration plan](../specs/assistant-layered-architecture.md#the-layer-model)
