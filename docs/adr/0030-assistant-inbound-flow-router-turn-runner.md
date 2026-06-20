# 0030 — assistant-inbound-flow-router-turn-runner

- **Status**: Accepted
- **Date**: 2026-06-20
- **Deciders**: @danil

## Context

Today the assistant's ingress fans out by hand inside `webhook.consumer` / `assistant.service`: a slash command goes one way, an ADR-0006 conflict callback (`confirm:` / `cancel:`) goes another, and everything else falls into `handleText` → `runToolLoop`. Each branch carries its own copy of "call the model / persist the turn / send the reply", and the decision of *which* branch is implicit, scattered across the consumer and the service.

Story 5 ([ADR 0010](0010-assistant-ask-user-stateful-resume.md)) introduces a case the code has never had: **a typed message that arrives while an `ask_user` question is pending** must be treated as the *answer* to that question (fed back as the `ask_user` `tool_result`, re-invoking the model), not as a fresh request. That is a genuinely new branch, and it must stay disjoint from the ADR-0006 conflict-confirm path — which resumes **deterministically, with no model call** — at the wire level, or the two suspend/resume mechanisms conflate and break ADR-0006's guarantee.

Bolting "is this a pending answer?" onto the existing `handleText` would deepen the very seam this milestone is closing. We need (1) one place that decides the flow, and (2) one place the model-running flows converge, so that a fresh message and an answer-to-a-question share **all** orchestration instead of duplicating it. This is **Story 6 / Wave 4** of the deferred-stories execution plan ([ADR 0022](0022-deferred-ai-comms-stories-execution-plan.md)); it lands **before** Story 5 / Wave 5 because the router is what delivers the typed-answer flow that `ask_user` needs. Design: [assistant-layered-architecture §taxonomy / Flow A/B](../specs/assistant-layered-architecture.md#the-inbound-flow-taxonomy-4-flows-one-gate).

## Decision

A single `classifyFlow(normalized, user)` returns **exactly one** of four flows, and the model-running flows reconverge on **one** turn-runner and **one** reply presenter.

```
classifyFlow(normalized, user):
  Command                                  → CommandFlow          (no LLM)
  Callback && data startsWith "confirm:"   → ConflictConfirmFlow  (ADR 0006, NO model)
  Callback && data startsWith "ask:"       → AnswerFlow           (button → re-invoke model)
  Text/Voice && pendingQuestionExists()    → AnswerFlow           (free-text → re-invoke model)
  else (Text/Voice, no pending)            → SimpleMessageFlow    (fresh turn)
```

- **The four flows.** `CommandFlow` (deterministic slash command, no LLM); `ConflictConfirmFlow` (a `confirm:` / `cancel:` callback → the ADR-0006 deterministic resolver, **no model** — [ADR 0006](0006-assistant-schedule-context-and-conflicts.md)); `AnswerFlow` (a `ask:` callback **or** free text while a question is pending → re-invoke the model with the answer); `SimpleMessageFlow` (everything else → a fresh turn).
- **The pending check is a cheap Redis `EXISTS`.** "Typed message while a question is pending" is resolved by `EXISTS pendingQuestionKey(userId)` (the hot index of the [PendingInteractionStore](0010-assistant-ask-user-stateful-resume.md)) **before** falling through to `SimpleMessageFlow` — no DB read on the common path, no model call to classify.
- **One convergence point.** A fresh message (Flow A) and an answer (Flow B) both seed a `TurnState` and call the **identical** turn-runner — `ToolLoopService.run(state)` — and both reconverge at a single `ReplyPresenter.present(outcome)`. No flow owns a second copy of "call the model / persist / send". The **only** divergence is one branch in the router plus one line in the `TurnRunner`: a button answer maps `optionId → label`; a free-text answer is the raw text. The loop is indifferent to which, because it already appends-and-re-enters every round — Flow B's seed is just "round zero's `tool_result` came from a human, not the dispatcher".
- **The `ask:` vs `confirm:` callback prefixes keep the two suspend/resume paths disjoint at the wire level.** `ask:` re-invokes the model (`pending_question`, [ADR 0010](0010-assistant-ask-user-stateful-resume.md)); `confirm:` / `cancel:` execute deterministically (`held_conflict`, [ADR 0006](0006-assistant-schedule-context-and-conflicts.md)). Different prefix, keyspace, store, and resolver — non-conflatable by construction.

**This wave is behaviour-preserving.** The `AnswerFlow` branch is wired but **inert** until Story 5: the `PendingInteractionStore` always returns "no pending question" (nothing writes a `pending_question` yet), so every `ask:` callback and every typed message falls through exactly as it does today. Existing command, conflict-confirm, and simple-message behaviour is **unchanged**, and all current assistant assertions — especially the **4 ADR-0006 cases** (held-no-reinvoke, confirm-writes, cancel-writes-nothing, partial-batch-no-rethrow) — stay green. Story 6 lays the **structural seam** that Story 5 plugs the durable store into; it does not, on its own, change any user-visible behaviour.

## Consequences

- ✅ **One gate, one decision.** The flow of every inbound is decided in exactly one place (`inbound-router.ts`, promoted from `webhook.consumer.routeForUser`), so adding the Story-5 answer case is a single branch, not a special-case threaded through `handleText`.
- ✅ **No duplicated orchestration.** Fresh-message and answer flows share `ToolLoopService.run` and `ReplyPresenter.present` — the convergence guarantee means a future flow cannot grow its own copy of "call the model / persist / send".
- ✅ **Story 5 plugs in cleanly.** The seam is in place: when the `PendingInteractionStore` starts returning real pending rows, the already-wired `AnswerFlow` branch activates with no further routing surgery.
- ✅ **The two suspend/resume paths stay disjoint** — `ask:` vs `confirm:` prefixes separate them at the wire, preserving ADR-0006's "deterministic, no model" guarantee while `ask_user` re-invokes the model.
- ✅ **Behaviour-preserving merge.** Wiring an inert branch + a convergence refactor lets this land and be reviewed *before* the durable store exists, decoupling the risky DB subsystem (Story 5) from the routing change.
- ⚠️ **Churn risk.** This is a correctness-neutral refactor that touches the ingress and orchestration seams (`webhook.consumer` / `assistant.service`) where the conflict-callback path lives. The **4 ADR-0006 cases are the merge gate** — a regression there is the principal hazard, and the refactor is best landed as part of (or directly before) Story 8's lift of those same files.
- ⚠️ **An inert branch ships ahead of its payload.** `AnswerFlow` exists with no `pending_question` to feed it until Story 5; until then it is dead-but-tested code. The risk is a stale or mis-wired branch silently rotting before Story 5 exercises it — mitigated by routing-level specs that assert the `EXISTS`-false fall-through to `SimpleMessageFlow`.
- ⚠️ **The `EXISTS` check is on the hot path of every typed message.** It is a single Redis round-trip (cheap), but it is now unconditional for text/voice inbound — acceptable, and far cheaper than a model call or a DB read, but not free.

## Alternatives considered

### Special-case ask/answer inside the existing `handleText`

Add an "is there a pending question?" check at the top of `handleText` and branch in place — the smallest diff. Rejected: it deepens the exact seam this milestone is closing (the lossy intent-reconstruction path where the narration bug lived, [ADR 0009](0009-assistant-narration-redrive.md)), leaves the flow decision implicit and scattered, and gives the answer flow no shared convergence point — it would grow its own copy of persist/send. A single explicit `classifyFlow` + one `runTurn` is the structural home the layered design ([assistant-layered-architecture §layer model](../specs/assistant-layered-architecture.md#the-layer-model)) calls for, and it is what makes Story 5 a plug-in rather than another special case.

### A Haiku "answer vs new request?" gate for in-window typed messages

Use the cheap background model to judge whether a typed message that arrives while a question is pending is actually an answer or an unrelated new request, instead of assuming any in-window text is the answer. Deferred (an optional fast-follow, not part of this wave). The durability policy already resolves the ambiguity deterministically — free text auto-resumes **only inside the 30-minute hot window**, and a button is the unambiguous durable answer carrier ([ADR 0010](0010-assistant-ask-user-stateful-resume.md)) — so the gate is a refinement (rejecting *in-window non-answers*), not a correctness requirement. The `completeStructured` plumbing for it already exists; we add it only if in-window misclassification is observed.

## References

- The story (acceptance criteria, out-of-scope, technical notes): [ai-workflow-tasks — Story 6](../specs/ai-workflow-tasks.md#story-6--inbound-4-flow-router--turn-runner-convergence)
- Deep design — the 4-flow taxonomy, Flow A/B convergence, the divergence-is-one-line guarantee: [assistant-layered-architecture §taxonomy / §Flow A / §Flow B](../specs/assistant-layered-architecture.md#the-inbound-flow-taxonomy-4-flows-one-gate)
- The durable answer store this router routes to (Wave 5, depends on this): [ADR 0010](0010-assistant-ask-user-stateful-resume.md)
- The deterministic conflict-confirm path the `confirm:` prefix keeps disjoint: [ADR 0006](0006-assistant-schedule-context-and-conflicts.md)
- The lossy intent-reconstruction seam this convergence closes: [ADR 0009](0009-assistant-narration-redrive.md)
- The layered home (`ingress/inbound-router.ts` + `session/turn-runner.service.ts`) and the migration step that lifts it: [assistant-layered-architecture §layer model / §migration plan](../specs/assistant-layered-architecture.md#the-layer-model)
- The wave plan placing this at Wave 4, before the answer store: [ADR 0022](0022-deferred-ai-comms-stories-execution-plan.md)
