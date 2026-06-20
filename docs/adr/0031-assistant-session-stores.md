# 0031 — assistant-session-stores

- **Status**: Accepted
- **Date**: 2026-06-20
- **Deciders**: @danil

## Context

`AssistantService` is the assistant's god-service: it owns the model-driven tool loop, the conflict hold/confirm path, the `ask_user` suspend/resume, the background-job fan-out — and, mixed into all of that, the raw persistence of the conversation itself. Three methods (`getOrCreateConversation`, `persistMessage`, `persistToolRounds`) and one constant (`MAX_AUDIT_RESULT_CHARS`) reach directly through the orchestrator into the conversation/message DB services to load-or-create the perpetual conversation, write each turn's user/assistant/synthetic message (stamping `lastActivityAt`), and write the forensic `role = tool` audit trail (one row per loop round, with the per-step result capped to bound jsonb growth).

That persistence is L3 session-state plumbing, not orchestration, yet it sits in the same class as the loop and reads two DB-service injections the rest of the orchestrator never touches. Every later lift in the layered migration ([assistant-layered-architecture §migration plan](../specs/assistant-layered-architecture.md#migration-plan-incremental-test-safe)) — the conflict store, the keystone tool-loop lift, the eventual deletion of `AssistantService` — is cleaner once the conversation/audit persistence is behind its own seam, because those steps stop having to carry the message-DB injections along for the ride.

This is **migration step #2** of the layered plan (the conversation/audit-store lift), the smallest, lowest-risk extraction, taken **before** the higher-blast-radius conflict ([ADR 0006](0006-assistant-schedule-context-and-conflicts.md)) and tool-loop lifts. It is a **behaviour-preserving relocation**: code moves, no logic changes. Design: [assistant-layered-architecture §layer model](../specs/assistant-layered-architecture.md#the-layer-model) (L3 session stores) and [§migration plan step 2](../specs/assistant-layered-architecture.md#migration-plan-incremental-test-safe).

## Decision

Two dedicated L3 stores own the conversation/audit persistence; `AssistantService` injects them and **delegates**.

- **`session/conversation.store.ts` — `ConversationStore`.** Owns the conversation lifecycle and message persistence: `getOrCreate(userId)` (load-or-create the perpetual conversation) and `persistMessage(conversation, role, contentType, content, vendorMessageId)` (write one row, stamp `lastActivityAt`). Injects the two 3-layer DB services it needs — `ConversationDatabaseService` + `ConversationMessageDatabaseService`.
- **`session/turn-audit.store.ts` — `TurnAuditStore`.** Owns the tool-loop audit trail: `persistToolRounds(conversationId, rounds)` (one `role = tool` message per round, the per-step result content capped to `MAX_AUDIT_RESULT_CHARS`, which **moves here** as a module constant). Injects only `ConversationMessageDatabaseService`.
- **`AssistantService` delegates.** Its three private methods keep their exact signatures but become thin forwarders to the two stores; the message-DB and conversation-DB injections are **removed** from the orchestrator (nothing else in the class used them). The orchestrator's many call sites (`handleText`, `finishTurn`, `handleCommand`, `handleCallback`, `resumeAnswer`, `holdAndAsk`, `suspendAndAsk`) are **unchanged** — they still call the same private methods.
- **Dependency direction is downward (L3 → L7).** Each store depends only on the DB services beneath it; nothing depends on the stores except the orchestrator above. Both providers are wired into `assistant.module.ts`.

**This step is behaviour-preserving.** The method bodies were lifted verbatim into the stores (the audit cap, the `lastActivityAt` stamp, the load-or-create branch, the summary/bounded-steps construction — byte-identical). No call site changed what it persists or when. The orchestrator's test (`assistant.service.spec.ts`) is updated **only at the seam** — it wraps real `ConversationStore`/`TurnAuditStore` instances around the same DB-service mocks and passes them to the constructor — so every existing `createInstance`/`save` assertion (and the `assistantReplies` helper) observes the **identical** persistence calls. All 434 unit tests stay green, including the 4 ADR-0006 conflict cases and the `ask_user` suspend/resume suite.

## Consequences

- ✅ **Persistence is behind one seam.** "Load-or-create the conversation / write a turn / write the audit trail" lives in two small, single-purpose L3 stores, not threaded through the orchestrator.
- ✅ **The orchestrator sheds two injections.** `AssistantService` no longer reaches the conversation/message DB services directly; the later lifts (conflict store, tool-loop keystone) inherit a smaller, cleaner constructor.
- ✅ **Reusable by the next layers.** The conflict resolver and turn runner that later move out of `AssistantService` ([§migration plan steps 4/10](../specs/assistant-layered-architecture.md#migration-plan-incremental-test-safe)) can inject the same stores instead of carrying their own copy of persist-a-message.
- ✅ **Behaviour-preserving, fully under test.** A verbatim lift with the spec retargeted at the seam (mocks unchanged) lands and reviews with zero behaviour delta — the lowest-risk way to start dismantling the god-service.
- ⚠️ **Two more providers + an extra hop.** `assistant.module.ts` grows two providers and each persist call is now one delegation deeper. The indirection is the point (the seam), but it is real and must be wired correctly (a missing provider is a boot-time DI failure, caught by the module wiring spec).
- ⚠️ **The audit cap moved.** `MAX_AUDIT_RESULT_CHARS` now lives in `turn-audit.store.ts`; anyone tuning the jsonb-growth bound looks there, not in the orchestrator.

## Alternatives considered

### Leave persistence inline in `AssistantService`

Keep the three methods and the constant where they are; defer the lift until a later step forces it. Rejected: the persistence is the easiest thing to extract and every subsequent lift is cleaner without it. Doing the cheap, zero-risk extraction first (before the conflict and tool-loop lifts whose merge gate is the 4 ADR-0006 cases) front-loads the safe churn and shrinks the diffs of the risky steps.

### One combined `SessionStore` for both conversation and audit

Fold conversation lifecycle, message writes, and the audit trail into a single store. Rejected: the two concerns have different dependencies and lifetimes — `ConversationStore` needs both DB services and stamps `lastActivityAt` on every user/assistant turn; `TurnAuditStore` needs only the message DB service, owns the size-cap constant, and **deliberately never** bumps `lastActivityAt` (the bracketing turns already did). Splitting them keeps each store single-purpose and lets the conflict/turn-runner layers inject only what they need.

### Inline the bodies at each call site (drop the private methods)

Remove the private forwarders and call the stores directly from `handleText`/`finishTurn`/etc. Rejected for this step: it would touch ~10 call sites and enlarge a diff whose entire value is being a verbatim, reviewable lift. Keeping the private methods as thin delegators preserves every call site unchanged; collapsing them is a later cosmetic cleanup, not part of the behaviour-preserving relocation.

## References

- The layered design — L3 session stores, the layer model, the step that lifts these: [assistant-layered-architecture §layer model / §migration plan step 2](../specs/assistant-layered-architecture.md#the-layer-model)
- The router/turn-runner convergence that lands at the end of the same migration (step 10): [ADR 0030](0030-assistant-inbound-flow-router-turn-runner.md)
- The conflict rule the later lifts must not break (the merge gate): [ADR 0006](0006-assistant-schedule-context-and-conflicts.md)
- The durable `ask_user` store this sits beside in `session/`: [ADR 0010](0010-assistant-ask-user-stateful-resume.md)
- The wave/execution plan: [ADR 0022](0022-deferred-ai-comms-stories-execution-plan.md)
