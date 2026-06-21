# 0013 — assistant-message-debounce-and-cancellation

- **Status**: Accepted
- **Date**: 2026-06-19
- **Deciders**: @danil

## Context

Each inbound message is **one BullMQ job**; there is **no debounce, coalescing, queue, or cancellation**, and `runToolLoop` has **no interrupt point**. The queue is **`attempts: 1`** ([ADR 0009](0009-assistant-narration-redrive.md)) — an abandoned turn does not replay, so any writes it already committed **persist**.

Two realities shape the design:

- Users send **rapid-fire** messages — a single thought split across bubbles, or a correction ("actually, Tuesday"). These should become **one** coherent turn, not several conflicting half-done ones.
- **Telegram delivers no inbound typing/recording signal to bots.** "Keep waiting while the user is typing" is therefore **not directly observable** — it can only be approximated by treating a quick follow-up as evidence the user was mid-thought.

The product owner locked the behaviour: **combine** window messages; **queue-after** on a mid-processing message; **STOP keeps writes** + a **programmatic** summary.

## Decision

We add a **per-user debounce window** (~2 s from the message timestamp, Redis-keyed, **re-armed** on each new inbound) that collapses window messages into **one turn by concatenation in arrival order** (the model reconciles corrections vs additions); during the window the status reads **"Waiting for you to finish…"**. A message arriving during **active processing** is **enqueued to run after** the current turn via a **per-user lock** — it **never cancels** the active turn. A **STOP** control — a **separate real inline-keyboard message** (drafts carry no buttons; prefix `stop:`) — sets a Redis flag the loop checks **between rounds and after each write**; on STOP the loop exits, **keeps committed writes** (consistent with `attempts: 1`), and replies with a **programmatically built** (no AI call) human-readable summary from the write ledger (e.g. *"Created 'Dentist' Tue 14:00; moved 'Standup' → 09:00"*). True typing detection is not possible; the re-armed debounce is the approximation.

## Consequences

- ✅ Rapid-fire messages become one turn; an "and also…" is **never silently dropped** (combine, not last-wins).
- ✅ No concurrent double-processing of one user (the per-user lock is shared with `ask_user` resume, [ADR 0010](0010-assistant-ask-user-stateful-resume.md)).
- ✅ STOP is instant and honest ("here's what I managed to do"); no fragile rollback subsystem.
- ⚠️ Combine can let a stale instruction linger; the model reconciles, and order is preserved so a later message can supersede an earlier one.
- ⚠️ **No real typing signal** — a user pausing beyond the window starts the turn; mitigated by re-arm on quick follow-ups (a documented limitation).
- ⚠️ STOP **keeps** partial writes (no rollback) — matches `attempts: 1`; a real Undo is a separate future feature.
- ⚠️ The cooperative checkpoint only fires **between rounds / after writes** — a long single model call can't be interrupted instantly.
- ⚠️ Coupled to `attempts: 1`: if the queue's attempts is ever raised, STOP semantics, coalescing, and status idempotency all need rework.

## Alternatives considered

### Latest-wins in the debounce window

Rejected — silently drops additions ("and also book the gym"); a dropped addition is a worse failure than the model reconciling a correction.

### Cancel-and-restart on a mid-processing message

Rejected — wastes the in-flight turn and risks half-applied writes racing the new turn; **queue-after** behind the per-user lock is safer.

### Rollback on STOP (compensating deletes)

Rejected — a sizable, error-prone subsystem (it must distinguish *this* turn's rows from pre-existing ones); **keep + summarize** matches the `attempts: 1` reality.

### AI-generated STOP summary

Rejected — it adds latency to a *cancel*; the write ledger already holds everything for a deterministic, instant summary.

## References

- Plan + verified Telegram facts + Stories 11/14: [ai-workflow-v2-plan](../specs/ai-workflow-v2-plan.md)
- The `attempts: 1` posture this depends on: [ADR 0009](0009-assistant-narration-redrive.md) · the shared per-user race: [ADR 0010](0010-assistant-ask-user-stateful-resume.md)
- The draft surface that can't carry the STOP button: [ADR 0012](0012-assistant-stateful-messenger-and-draft-streaming.md)
</content>
