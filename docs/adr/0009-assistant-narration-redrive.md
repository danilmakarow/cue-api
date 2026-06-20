# 0009 — assistant-narration-redrive

- **Status**: Accepted
- **Date**: 2026-06-19
- **Deciders**: @danil

## Context

The assistant's tool-use loop ([specs/ai-workflow.md](../specs/ai-workflow.md)) terminates the moment the model returns a turn with no `tool_use` blocks. On a **batch write** ("create all seven driving lessons"), the model frequently tips into *planning-narration*: it returns `stop_reason: end_turn` with text — e.g. "…Создаю все семь в группе Driving Lessons." — and **zero tool calls**. The loop relays that text as the reply; nothing is written. This was confirmed from production data (the seven tasks never existed in the DB; the user was told they were created).

The loop cannot distinguish this from a legitimate clarifying question — both are `end_turn` + text + no tool calls — so it terminates on the first such turn, never giving the model a round on which it actually emits the `create_task` calls. A later `isFalseSuccessReply` guard *detects* the false claim (and swaps the text) but **never re-drives** the model, so the action still does not happen. This failure class is distinct from an [ADR 0006](0006-assistant-schedule-context-and-conflicts.md) conflict: there the model produced an action that *clashed*; here it produced **no action at all**.

## Decision

When a turn ends with **no tool calls**, the loop classifies it instead of returning unconditionally:

- `committedWrites > 0` **or** a clarifying-question / honest-failure (the `CLAIM_VETO_PATTERN`) → **genuine** terminal; send the reply (the veto is the hard floor that keeps real questions passing through).
- otherwise (zero commits, not a question) → **narration-without-write**. Append a corrective **user** message ("you described a change but issued no tool calls; call them now, or ask one clarifying question"), set `tool_choice: 'any'` for the **next round only**, and **re-drive** the model.

The re-drive trigger is **structural** (zero tool calls + zero commits + not-a-question); a first-person mutation-claim regex is only a logging hint, never required — so an English "Creating all seven…" re-drives too. The corrective nudge is a plain user `PromptBlock`, **never** a synthetic `ToolRound` (a fabricated `tool_result` with no matching `tool_use` is an Anthropic 400). Corrections are capped at `ASSISTANT_MAX_CORRECTIONS` (default 5, strictly `< ASSISTANT_MAX_TOOL_ROUNDTRIPS`); on exhaustion the turn **escalates** — a structured `assistant.correction_exhausted` log + the alert sink (Sentry, ADR-0007-style connector) + an honest reply to the user. It does **not** throw (the BullMQ webhook queue is `attempts: 1`; a throw would not replay, and raising attempts later would require `UnrecoverableError`). `ASSISTANT_MAX_CORRECTIONS = 0` is the kill-switch (reverts to the detect-and-mask guard).

## Consequences

- ✅ The action is **recovered automatically** — the model is re-driven until the writes commit, instead of the user re-asking by hand.
- ✅ The structural trigger catches narration the lexical guard misses (EN verbs, gerunds).
- ✅ Reconciles with the existing guard (now defence-in-depth) and the held-conflict flow (mutually exclusive: a held write returns before any terminal check; a narration turn never enters the hold path).
- ✅ Bounded and observable: a correction budget below the round-trip ceiling, a structured escalation event, a kill-switch.
- ⚠️ A forced `tool_choice: 'any'` can make a stalling model call a read instead of the write; bounded by the corrections cap and the 5-fetch cap, it terminates into escalation rather than looping.
- ⚠️ The "no throw" escalation is correct **only** while the queue is `attempts: 1`; raising attempts later forces a switch to `UnrecoverableError` (recorded here).
- ⚠️ Partial-batch ("5 of 7 committed") is out of scope — `committedWrites > 0` short-circuits to genuine; the confirmed bug is the **zero-commit** case.

## Alternatives considered

### Lexical-only trigger (gate re-drive on the mutation-claim regex)

Smallest change, but inherits the regex's blind spots — an English batch narration would neither be detected nor re-driven. Rejected as the trigger; the regex survives only as a confidence/logging hint.

### Keep the detect-and-mask guard only

`isFalseSuccessReply` already replaces the lie with "nothing was saved, try again". Rejected — it never creates the tasks; the user must re-ask manually. Masking ≠ recovery.

### Throw to fail the BullMQ job as the escalation

Visible in queue dashboards, but a latent footgun: if `attempts` is ever raised it replays the whole turn and re-creates tasks unless converted to `UnrecoverableError`. Rejected as default in favour of the alert sink.

### Batch `create_tasks` tool alone (no re-drive)

Reduces the cognitive load that tips the model into narration, but does not eliminate it (a model can narrate even a single batch call). Necessary-but-insufficient; shipped alongside, not instead.

## References

- Today's flow + the confirmed failure mode: [specs/ai-workflow.md](../specs/ai-workflow.md)
- Full design: [specs/assistant-tool-loop-redrive.md](../specs/assistant-tool-loop-redrive.md) · structural home: [specs/assistant-layered-architecture.md](../specs/assistant-layered-architecture.md)
- The distinct, deterministic conflict path: [ADR 0006](0006-assistant-schedule-context-and-conflicts.md)
- Vendor-neutral connector (the `AiToolChoice` + alert sink pattern): [ADR 0007](0007-provider-connector-abstraction.md)
