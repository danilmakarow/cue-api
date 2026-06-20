# 0036 — assistant-turn-runner-convergence

- **Status**: Accepted
- **Date**: 2026-06-20
- **Deciders**: @danil

## Context

This is the **final** step of the Story 8 layered-refactor sequence ([ADR 0031](0031-assistant-session-stores.md) session stores, [ADR 0032](0032-assistant-reply-egress-layer.md) reply/egress, [ADR 0033](0033-assistant-conflict-layer.md) conflict, [ADR 0034](0034-assistant-tool-loop-orchestration-layer.md) tool loop, [ADR 0035](0035-assistant-orchestration-helper-extraction.md) re-drive/ledger/terminal-classifier). After those waves, the heavy machinery — persistence, the bounded agent loop, the conflict replay, the egress send surface — all lived in dedicated downward layers, but the **turn lifecycle** that stitches them together still lived in `AssistantService`: `handleText` / `finishTurn` / `resumeAnswer` / `claimPending` / `appendSyntheticAnswer` / `suspendAndAsk` / `parseAskCallback` / `triggerBackgroundJobs` / `holdAndAsk`.

`TurnRunnerService` (introduced by [ADR 0030](0030-assistant-inbound-flow-router-turn-runner.md) as the single model-driven convergence point) was a **thin shim**: its `runTurn` branched on `TurnState.origin` and called *back up* into `AssistantService.handleText` / `resumeAnswer`. That left the convergence-point class owning nothing and the orchestrator owning the lifecycle — an upward dependency (`session/turn-runner` → `assistant.service`) inverting the layer model, and the "real" home for the lifecycle still being the very god-class the milestone set out to dissolve.

This wave converges the two: the turn-lifecycle bodies move **down** into `TurnRunnerService`, which becomes the genuine owner of seed-fresh-vs-resume + persist + loop + present + hold + suspend/resume + background. With the lifecycle gone, what remains on `AssistantService` is only the two deterministic, no-LLM entry points the consumer still calls directly. Design: [assistant-layered-architecture §migration plan / §L3 turn runner](../specs/assistant-layered-architecture.md#the-layer-model).

## Decision

**Move the turn lifecycle into `TurnRunnerService`; reduce `AssistantService` to a thin command-surface facade.** The method bodies are relocated verbatim (relocation + re-wiring, not a rewrite).

- **`session/turn-runner.service.ts` now owns the lifecycle.** `handleText`, `finishTurn`, `resumeAnswer`, `claimPending`, `appendSyntheticAnswer`, `suspendAndAsk`, `parseAskCallback`, `triggerBackgroundJobs`, `holdAndAsk`, plus the private persist delegators (`getOrCreateConversation` / `persistMessage` / `persistToolRounds`) and the four user-facing reply constants (`AI_FAILURE_REPLY`, `CLAIM_WITHOUT_WRITE_REPLY`, `CORRECTION_EXHAUSTED_REPLY`, `CORRECTION_EXHAUSTED_EVENT`) move here. It injects, strictly downward: the alert connector, `ToolLoopService` (L4), `SummarizerService` / `MemoryExtractorService` (background), `ConversationStore` / `TurnAuditStore` (L3 stores), `PendingInteractionService` (ADR 0010), `ReplyPresenter` (L9), and `HeldConflictStore` (L8 state). `runTurn` now calls the **local** `handleText` / `resumeAnswer` — no upward hop.
- **`AssistantService` is reduced to a facade, NOT deleted.** The webhook consumer still dispatches two deterministic, no-LLM flows to it — `handleCommand` (slash command → run handler, reply, persist synthetic line) and `handleCallback` (ADR-0006 conflict confirm/cancel → delegate to `ConflictResolverService`). It injects only `CommandHandlerService`, `ConversationStore`, `ReplyPresenter`, and `ConflictResolverService`, keeping the dependency graph strictly downward. DELETE was rejected (see Alternatives): the consumer references both methods, so a facade is the lower-churn option that leaves the ingress untouched.
- **The upward dependency is severed.** `TurnRunnerService` no longer imports `AssistantService`; `AssistantService` does not import `TurnRunnerService`. The former cycle-risk (shim → orchestrator) is gone, and no module wiring changed — both providers were already registered in `assistant.module.ts`, and the consumer's constructor signature (`assistantService`, `turnRunner`) is unchanged.
- **Spec rehome: assertions MOVE per layer, none deleted.** The 1,627-line `assistant.service.spec.ts` is retired; its assertions are relocated verbatim into per-layer suites that drive the method on its new owner:
  - `session/turn-runner.service.spec.ts` — the 28 lifecycle/loop/re-drive/ask-suspend/answer-resume cases (driving `turnRunner.handleText` / `turnRunner.resumeAnswer`), including the held-**hold** case (it is a loop-tail outcome, not a callback).
  - `conflict/conflict-resolver.service.spec.ts` — the **4 ADR-0006 callback cases** + the two recurring-replay cases (driving `handleCallback` through the `AssistantService` facade, which loads the conversation and delegates to the resolver).
  - `webhook.consumer.spec.ts` — its routing assertions retarget the seam the consumer actually dispatches to: `turnRunner.runFromMessage` (was the now-moved `assistantService.handleText`).

  Each harness wraps **real** layer instances (`ConversationStore`, `TurnAuditStore`, `ReplyPresenter`, `HeldConflictStore`, `ConflictResolverService`, `ToolLoopService`) around the same DB-service / vendor / redis / dispatcher mocks, so every relocated assertion observes the **identical** persistence / send / loop calls through the new owner — no assertion was weakened or dropped.

**This wave is behaviour-preserving.** It is pure relocation + re-wiring: bodies move verbatim, the consumer's dispatch is unchanged, and the full assistant unit suite stays green (447 tests, up from the pre-rehome count purely because the assertions now live in three suites instead of one). The 4 ADR-0006 cases — the standing merge gate across this whole sequence — pass unchanged in their new home.

## Consequences

- ✅ **The layer model is now strictly downward.** `TurnRunnerService` (L3) depends only on L4/L8/L9/stores/background; `AssistantService` (facade) depends only on the command handler + conflict resolver + stores + presenter. No layer reaches up.
- ✅ **One real owner per concern.** The convergence point introduced by ADR 0030 is no longer a shim that delegates upward — it *is* the turn lifecycle. "Where does a fresh turn / an answer resume run?" has a single, honest answer.
- ✅ **The god-class is dissolved.** `AssistantService` shrinks from ~680 lines to a ~130-line facade carrying only the two deterministic no-LLM entry points; the milestone's original seam (lossy intent reconstruction, [ADR 0009](0009-assistant-narration-redrive.md)) is fully decomposed across L3–L9.
- ✅ **Per-layer specs.** Lifecycle, conflict-callback, and routing assertions now live next to the code that owns them, so a future change to one layer touches one spec, not a 1,600-line omnibus.
- ⚠️ **A thin facade survives rather than disappearing.** `AssistantService` could feel vestigial (two methods). It is retained deliberately: it is the consumer's stable handle for the no-LLM paths and keeps conversation-loading out of the consumer. If the command surface later grows or a `CommandRunnerService` is split out, this facade is the natural seam to revisit.
- ⚠️ **Highest-churn step of the sequence.** Moving the lifecycle touches the most-asserted class and forces the spec rehome + a consumer-spec retarget. Risk was MEDIUM; the mitigation was relocating bodies verbatim and wrapping real layers in every harness so the gate (the 4 ADR-0006 cases + the full loop suite) is exercised unchanged.
- ⚠️ **The consumer-spec assertions changed shape (not strength).** Three routing assertions moved from `assistantService.handleText(user, params)` to `turnRunner.runFromMessage({ user, ... })` because the target method physically moved. This is a forced setup change, not a softened assertion — the routing outcome asserted is identical.

## Alternatives considered

### Delete `AssistantService` entirely

Fold `handleCommand` into a new `CommandRunnerService` and have the consumer call `ConflictResolverService.handleCallback` directly, removing the class. Rejected as **higher churn for no structural gain**: the consumer would then load the conversation itself (leaking an L3 concern into ingress) or `ConflictResolverService` would need a get-or-create entry overload, and a second new provider (`CommandRunnerService`) would have to be created and wired. The facade keeps the consumer's dispatch and constructor identical and confines conversation-loading to one place. If the command surface grows, splitting it out later is a clean additive step.

### Leave the shim; only re-point its internals

Keep `TurnRunnerService.runTurn` delegating, but move the bodies into private helpers it calls — avoiding the constructor change. Rejected: it does not sever the upward `turn-runner → assistant.service` import (the helpers would still live on `AssistantService`), so the layer inversion and the god-class both persist. The point of this wave is to relocate ownership, not to hide the delegation.

### Keep the omnibus `assistant.service.spec.ts`, re-point it at the new owners

Leave one giant suite but have it `new TurnRunnerService(...)` / `new ConflictResolverService(...)` internally. Rejected: it perpetuates the 1,600-line catch-all the layered design is trying to retire and couples unrelated layers' tests into one file. Splitting per layer is the spec-side mirror of the code-side decomposition.

## References

- The convergence point this wave makes the real owner (was a shim): [ADR 0030](0030-assistant-inbound-flow-router-turn-runner.md)
- The downward layers the runner now composes: [ADR 0031](0031-assistant-session-stores.md), [ADR 0032](0032-assistant-reply-egress-layer.md), [ADR 0033](0033-assistant-conflict-layer.md), [ADR 0034](0034-assistant-tool-loop-orchestration-layer.md), [ADR 0035](0035-assistant-orchestration-helper-extraction.md)
- The ADR-0006 cases that are the standing merge gate: [ADR 0006](0006-assistant-schedule-context-and-conflicts.md)
- The durable suspend/resume the runner drives: [ADR 0010](0010-assistant-ask-user-stateful-resume.md)
- The narration re-drive the loop-tail honours: [ADR 0009](0009-assistant-narration-redrive.md)
- The layer model + migration plan this step completes: [assistant-layered-architecture §the layer model](../specs/assistant-layered-architecture.md#the-layer-model)
