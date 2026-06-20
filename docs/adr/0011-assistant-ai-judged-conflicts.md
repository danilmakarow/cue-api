# 0011 — assistant-ai-judged-conflicts

- **Status**: Accepted
- **Date**: 2026-06-19
- **Deciders**: @danil

## Context

[ADR 0006](0006-assistant-schedule-context-and-conflicts.md) layer 4 resolves a write overlap **deterministically**: the dispatcher holds the clashing write in Redis and asks the user via an inline keyboard ("Book anyway / Cancel"), **never re-invoking the model**. ADR 0006 explicitly *rejected* the "return the conflict to the model to reconcile" alternative — for three reasons: an extra Sonnet round-trip per conflict, nondeterminism (the model might propose *another* clashing slot), and the risk of a silent double-booking.

Three things have changed since that decision:

- **`ask_user` is now a durable, stateful escalation** ([ADR 0010](0010-assistant-ask-user-stateful-resume.md)) — a question can suspend the turn and resume precisely, so "ask the user" no longer means a lossy deterministic side-channel.
- **The narration re-drive** ([ADR 0009](0009-assistant-narration-redrive.md)) classifies terminal turns and bounds correction loops, so a model that fails to act is caught, not trusted blindly.
- **v2 wants the assistant to feel like a person.** A rigid "Book anyway?/Cancel" popup on *every* overlap is robotic, and the deterministic path cannot honour a standing user preference ("I don't mind my workouts overlapping") or in-message authorization ("yes, double-book it").

The product owner chose to hand the conflict decision to the AI under a **strict default-deny** safety posture.

## Decision

We replace ADR-0006 **layer 4** with **AI-judged conflicts**. On an overlapping timed write, the dispatcher returns a **recoverable `isError` tool result** describing the clash and restating a default-deny instruction ("overlaps 'X' (start–end); do NOT proceed unless the user explicitly accepted"); the model decides. It proceeds over a conflict **only** when (a) the user authorized it **in the current message**, or (b) a durable, **explicit** `conflict_policy` `UserMemoryFact` permits it (**user-set, never inferred** by the memory extractor); otherwise it calls **`ask_user`** ([ADR 0010](0010-assistant-ask-user-stateful-resume.md)). Any **destructive replace** (deleting an existing event to make room) requires an explicit `ask_user` first. The deterministic Redis hold, the `confirm:`/`cancel:` inline keyboard, and the held-batch executor are **removed**; `TaskService.findOverlapping` is **kept** as the conflict-description source. **Layers 1–3 of ADR 0006 (preload, query-aware augmentation, the 5-fetch cap) are unchanged.**

## Consequences

- ✅ Natural conversation — the assistant honours "overlaps are fine for X" and acts in one turn instead of a popup.
- ✅ The lossy in-flight context is preserved by `ask_user`'s stateful resume, not a deterministic side-channel.
- ✅ Reuses `ask_user` + the re-drive loop; no second confirmation mechanism, and the held-conflict Redis state + expiry path are deleted.
- ⚠️ A deterministic safety gate becomes **model judgement** — a prompt regression could silently double-book. Mitigation: default-deny stated in **both** the system prompt **and** every conflict tool-result; the standing flag is **user-set only**; destructive replace **always** asks.
- ⚠️ Re-introduces the **extra round-trip per real conflict** that ADR 0006 avoided — accepted as the price of natural UX; bounded by the round-trip + correction budgets.
- ⚠️ Recurring-series conflicts remain out of scope (an expanded series clashing on many dates does not fit one ask) — tracked separately (the write-side recurring-conflict gap).
- ⚠️ This **reverses** ADR 0006's explicit rejection of "return the conflict to the model"; the new guardrails (default-deny + durable explicit flag + `ask_user` durability) are what make it acceptable now.

## Alternatives considered

### Keep the deterministic hold (ADR 0006 status quo)

Rejected by the product owner: robotic, cannot honour a standing "overlaps OK" preference, and a popup on every clash is poor UX for a personal assistant. (The original safety argument is now met by the default-deny posture.)

### Looser AI judgement (infer acceptability from category / history)

Rejected — double-booking is safety-relevant and the memory extractor is too noisy to be trusted to *infer* it. The standing flag must be explicit-user-set.

### Always ask, no durable preference

Rejected — forces a popup-equivalent every single time; the durable explicit flag lets a power user opt out once and for all.

### Let the model delete/replace by default to "resolve" a clash

Rejected — destructive and irreversible; a replace must be gated behind an explicit `ask_user`.

## References

- The decision this supersedes (layer 4 only): [ADR 0006](0006-assistant-schedule-context-and-conflicts.md)
- The escalation path it relies on: [ADR 0010](0010-assistant-ask-user-stateful-resume.md) · the terminal-turn classifier: [ADR 0009](0009-assistant-narration-redrive.md)
- Design + acceptance criteria: [ai-workflow-tasks Story 15](../specs/ai-workflow-tasks.md) · research: [ai-workflow-v2-research §D](../specs/ai-workflow-v2-research.md)
</content>
