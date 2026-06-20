# 0032 — assistant-reply-egress-layer

- **Status**: Accepted
- **Date**: 2026-06-20
- **Deciders**: @danil

## Context

Until now the assistant orchestrator (`assistant.service.ts`) was the direct caller of every vendor send API. The `ExternalVendorConnector` was injected into the god-service, and its `sendMessage` / `sendActions` / `acknowledgeCallback` methods were invoked from five scattered sites: `sendReply` (plain text), `sendQuestion` (the `ask_user` keyboard, ADR 0010), `holdAndAsk` (the held-conflict confirm/cancel keyboard, ADR 0006), and the `acknowledgeCallback` calls in `handleCallback` and `resumeAnswer`. Two of those sites built inline-keyboard button arrays by hand, mixing button-shape construction (a pure mapping) with the IO call and with the orchestration around it.

This is the egress half of the seam the [layered architecture](../specs/assistant-layered-architecture.md#the-layer-model) calls L9 (reply / egress): the place where a resolved outcome becomes vendor IO. Leaving it fused into the orchestrator means the keystone tool-loop lift (step 5) and the eventual `TurnRunner` convergence (step 10) still drag the vendor connector and its keyboard-building along with them, and the "no flow owns its own copy of *send*" convergence guarantee has no single home to point at. There is also a correctness reason to centralize: the send sites all share the same "swallow a send failure with a log, never crash the turn" contract (the BullMQ queue is `attempts:1`, so a thrown send would lose the turn) — that contract should live in one layer, not be re-derived at each call site.

This is **migration step 3** of the assistant layering plan ([assistant-layered-architecture §migration plan](../specs/assistant-layered-architecture.md#migration-plan-incremental-test-safe)), following the session-store lift (step 2, [ADR 0031](0031-assistant-session-stores.md)). Like that step it is a **behaviour-preserving lift**: code moves, no logic changes.

## Decision

Introduce one egress layer — `reply/reply-presenter.service.ts` (`ReplyPresenter`) — as the **SOLE** caller of `vendor.sendMessage` / `vendor.sendActions` / `vendor.acknowledgeCallback`, plus a pure `reply/quick-reply.builder.ts` for the two inline keyboards.

- **`ReplyPresenter` owns the vendor connector.** `ExternalVendorConnector` is injected here and **nowhere else** in the assistant module. Its methods are the verbatim former orchestrator bodies: `sendText` (was `sendReply`), `sendQuestion` (was `sendQuestion`), `sendHeldKeyboard` (the keyboard send lifted out of `holdAndAsk`), and `acknowledgeCallback` (a thin pass-through). The send-failure-swallowing log contract moves with them, intact.
- **`quick-reply.builder.ts` is pure button construction.** `buildHeldKeyboard(heldCount, token)` produces the ADR-0006 confirm/cancel row (pluralizing "Book all anyway" for a batch); `buildAskKeyboard(options, pendingQuestionId)` produces the ADR-0010 `ask:<pendingQuestionId>:<optId>` row. They map domain inputs to vendor-agnostic `OutboundActionButton[][]` and touch no IO, so the exact wire strings are now unit-coverable in isolation while the presenter stays the only sender.
- **The orchestrator delegates.** `AssistantService` keeps the *decision* of what to say (the `LoopOutcome` branching in `finishTurn`, the held-prompt wording, the false-success guard) but hands every actual send to `this.replyPresenter`. At the end of this step the `vendor` injection is **removed from the `AssistantService` constructor** entirely.
- **`ReplyPresenter` is wired in `assistant.module.ts`** as a provider and injected into `AssistantService`.

**This step is behaviour-preserving.** Every send goes to the same vendor method with the same arguments it received before — the button arrays are byte-identical (the builder reproduces the prior inline literals), the no-options-`ask_user` path still routes through the text send, and the failure-swallowing logs are unchanged. The orchestrator spec keeps **every** existing assertion: the harness now wraps a **real** `ReplyPresenter` around the same `vendor` jest mock (mirroring how step 2 wrapped real stores around the DB-service mocks), so every `vendor.sendMessage` / `vendor.sendActions` / `vendor.acknowledgeCallback` expectation observes the identical call through the new layer. No assertion was changed or deleted; only the constructor wiring in the test setup was updated.

## Consequences

- ✅ **One egress chokepoint.** Every byte the assistant sends to a vendor now flows through `ReplyPresenter`. The `vendor.*` send surface has exactly one caller, verifiable by grep — so the keystone tool-loop lift and the `TurnRunner` convergence can move without dragging the connector, and the "no flow owns its own copy of *send*" guarantee has a concrete home.
- ✅ **Pure keyboards, testable in isolation.** Button-shape construction is separated from IO; the `confirm:` / `cancel:` / `ask:` wire strings are now pure-function outputs, coverable without a vendor mock.
- ✅ **The fail-soft send contract is single-sourced.** "Swallow a send failure with a log, never crash the turn" lives in one layer instead of being re-implemented at each call site.
- ✅ **Behaviour-preserving lift.** The 4 ADR-0006 cases, the ADR-0010 ask/resume cases, and the narration/false-success cases all stay green with their assertions untouched — only the test's constructor wiring changed.
- ⚠️ **A presenter method shares the `acknowledgeCallback` name.** The layer's pass-through is `ReplyPresenter.acknowledgeCallback`, so a literal `grep acknowledgeCallback` outside `reply/` still matches the two orchestrator *delegations* (`this.replyPresenter.acknowledgeCallback(...)`). The load-bearing invariant — zero `vendor.*` connector calls outside `reply/` — holds exactly (`grep '\.vendor\.'` outside `reply/` is empty). The residual hits are presenter calls, not vendor calls; the name is kept because it mirrors the connector method it fronts.
- ⚠️ **A thin layer for now.** `ReplyPresenter` is currently four short methods. Its value is the chokepoint and the convergence anchor, not its size; it grows the natural home for a future `present(outcome)` once the tool-loop and turn-runner steps land.

## Alternatives considered

### Leave the send sites in the orchestrator until the tool-loop lift

Defer the egress extraction and pull `sendReply` / `sendActions` out as part of step 5 (the keystone `runToolLoop` lift). Rejected: that step is already the highest-risk move, and folding the vendor-connector relocation into it widens its blast radius for no benefit. The egress lift is independent, low-risk, and mechanical — doing it first shrinks the keystone step and gives it a `ReplyPresenter` to delegate to rather than a connector to carry.

### A single `present(outcome: LoopOutcome)` method instead of granular send methods

Have the presenter take the whole `LoopOutcome` and own the `finishTurn` branching. Rejected for this step: that moves *decision* logic (which reply, the false-success guard, the held-prompt wording) out of the orchestrator, which is a behaviour-relocation beyond a pure egress lift and would force rewriting orchestrator assertions. Granular `sendText` / `sendQuestion` / `sendHeldKeyboard` methods keep the move byte-for-byte behaviour-preserving now; the `present(outcome)` convergence point is a later step once L5/L10 land.

## References

- The layered home (`reply/reply-presenter.service.ts` + `reply/quick-reply.builder.ts`) and the migration step that lifts it: [assistant-layered-architecture §layer model / §migration plan](../specs/assistant-layered-architecture.md#the-layer-model)
- The prior lift in this sequence (session stores, step 2): [ADR 0031](0031-assistant-session-stores.md)
- The held-conflict keyboard this layer now sends (`confirm:` / `cancel:`): [ADR 0006](0006-assistant-schedule-context-and-conflicts.md)
- The `ask_user` keyboard this layer now sends (`ask:<row>:<id>`): [ADR 0010](0010-assistant-ask-user-stateful-resume.md)
- The vendor-agnostic connector contract this layer is the sole caller of: [ADR 0007](0007-provider-connector-abstraction.md)
- The router that owns the disjoint callback prefixes the keyboards carry: [ADR 0030](0030-assistant-inbound-flow-router-turn-runner.md)
