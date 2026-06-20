# 0035 — assistant-orchestration-helper-extraction

- **Status**: Accepted
- **Date**: 2026-06-20
- **Deciders**: @danil

## Context

The L4 tool-loop lift (step 5, [ADR 0034](0034-assistant-tool-loop-orchestration-layer.md)) moved the agent loop into `orchestration/tool-loop.service.ts`, but it moved the loop's *pure decision helpers* with it as `private` methods and file-local constants: the terminal-turn classifier (`classifyTerminalTurn`, `terminalReplyText`) with the veto/claim regexes (`MUTATION_CLAIM_PATTERN`, `CLAIM_VETO_PATTERN`) and the reply strings (`ROUNDTRIP_CEILING_REPLY`, `TRUNCATED_REPLY`, `REFUSAL_REPLY`); the narration re-drive construction (`CORRECTIVE_NUDGE`, `buildNarrationAuditRound`, the `corrections >= maxCorrections` budget check); and the write-accounting (`isFalseSuccessReply`, the inline `attempted/committed += outcome.count ?? …` ledger delta).

These are **pure functions** — no DI, no I/O, no state — fused into a 700-line stateful service whose actual job is *driving* the loop, not *deciding* with regexes. Three concerns are tangled in one file: the `ToolLoopService` is the only thing that can see them, the regexes are buried mid-file behind the loop body, and the false-success patterns are shared with the orchestrator only by exposing a `public` method on the service. The [layered architecture](../specs/assistant-layered-architecture.md#the-layer-model) names these as the loop's **pure L4 decision helpers**, separable from the impure loop driver.

This is **migration step 8** of the assistant layering plan. It is a **PURE relocation**: the helper bodies move verbatim into named modules, the loop *imports* and *delegates* to them, and the regexes get a **single source** that both the classifier and the write-ledger import (today `classifyTerminalTurn` and `isFalseSuccessReply` each carried their own copy of the same two patterns). Risk is LOW–MEDIUM — the bodies are unchanged, but the regexes that gate the ADR-0009 narration re-drive are the most behaviourally subtle code in the file.

## Decision

Split the loop's pure decision helpers out of `ToolLoopService` into three pure, DI-free L4 modules under `orchestration/`, and have `ToolLoopService` import and delegate to them.

- **`orchestration/terminal-classifier.ts`** is the **single source** of the veto/claim regexes (`MUTATION_CLAIM_PATTERN`, `CLAIM_VETO_PATTERN`) and owns the terminal-turn decision: `classifyTerminalTurn` (now an exported arrow), `terminalReplyText`, the `TerminalClassification` type, and the terminal reply strings (`ROUNDTRIP_CEILING_REPLY`, `TRUNCATED_REPLY`, `REFUSAL_REPLY`). Bodies move verbatim; only the `private method` → exported `const = (…) =>` form changes.
- **`orchestration/correction-driver.ts`** owns the ADR-0009 corrective-nudge construction: the `CORRECTIVE_NUDGE` user message, `buildNarrationAuditRound`, and a new `isCorrectionBudgetExhausted(corrections, maxCorrections)` helper that names the former inline `corrections >= this.config.maxCorrections` check.
- **`orchestration/write-ledger.ts`** owns write accounting: `isFalseSuccessReply` (the verbatim body, now importing the two patterns from `terminal-classifier.ts` rather than holding its own copy) and a new `writeLedgerDelta(attemptedCount, committedCount, isError)` helper that names the former inline per-tool `?? 1` / `?? (isError ? 0 : 1)` fallback.
- **`ToolLoopService` delegates.** The former private `classifyTerminalTurn` / `terminalReplyText` / `buildNarrationAuditRound` methods are deleted; the loop calls the imported functions directly. The inline budget check becomes `isCorrectionBudgetExhausted(...)` and the inline write delta becomes `writeLedgerDelta(...)`. `isFalseSuccessReply` **stays as a one-line `public` delegating method** (`return isFalseSuccessReply(text, committed, attempted)`) so the orchestrator's post-loop guard call site — `this.toolLoop.isFalseSuccessReply(...)` in `finishTurn` — is **untouched**, while the patterns are now single-sourced in `write-ledger.ts`.

**This step is behaviour-preserving.** The modules are pure (no DI), so **no module wiring changes** — `assistant.module.ts` is untouched, and `ToolLoopService`'s constructor signature is unchanged, so the orchestrator spec's harness (which wraps a real `ToolLoopService` around the same mocks) keeps **every** assertion and its identical instantiation. The regexes are the byte-identical patterns; the reply strings are byte-identical; the classifier, re-drive, and ledger logic are moved intact. The `LoopOutcome.unresolved` → `alert.capture('assistant.correction_exhausted')` escalation stays where it lives (the orchestrator's `finishTurn`), untouched. No assertion was changed or deleted.

## Consequences

- ✅ **One source for the regexes.** `MUTATION_CLAIM_PATTERN` / `CLAIM_VETO_PATTERN` live in exactly one module; the classifier and the write-ledger import them instead of each carrying a copy, so the two paths can never drift.
- ✅ **The pure helpers are independently testable and importable.** `classifyTerminalTurn`, `terminalReplyText`, `isFalseSuccessReply`, `buildNarrationAuditRound`, `writeLedgerDelta`, and `isCorrectionBudgetExhausted` are plain functions with no service to construct — callable directly, no Nest test module.
- ✅ **The loop service shrinks to the driver.** `ToolLoopService` keeps the impure orchestration (the model loop, dispatch, suspension, held-batch collection) and the one `buildHeldPrompt` that legitimately needs the injected resolver; the regex/string/accounting decisions left with the pure modules.
- ✅ **Behaviour-preserving lift.** Full suite green (35 suites / 447 tests), every assertion untouched; the relocation reads as move, not rewrite.
- ✅ **No new wiring.** Pure modules need no provider; `assistant.module.ts` and the `ToolLoopService` constructor are unchanged, so the seam adds zero DI surface.
- ⚠️ **`isFalseSuccessReply` keeps a thin delegating method on the service.** Rather than re-point the orchestrator at the bare function, the loop retains a one-line `public` pass-through so `this.toolLoop.isFalseSuccessReply(...)` — and its spec assertions — stay byte-identical. The real logic is single-sourced in `write-ledger.ts`; the method is now pure indirection.
- ⚠️ **Three small modules instead of one.** The orchestration directory gains three files for what was inline; the trade is more files for separable, single-purpose, DI-free units — accepted, consistent with the layer model.

## Alternatives considered

### Leave the helpers as private methods on `ToolLoopService`

Keep `classifyTerminalTurn` / `terminalReplyText` / `buildNarrationAuditRound` / `isFalseSuccessReply` private on the service. Rejected: the two regexes were duplicated across `classifyTerminalTurn` and `isFalseSuccessReply` inside the same file, and the patterns that gate the narration re-drive deserve one named home; a pure regex/decision helper has no reason to be reachable only through a constructed service.

### Drop the `isFalseSuccessReply` delegating method and import the bare function at the orchestrator

Have `AssistantService.finishTurn` import `isFalseSuccessReply` from `write-ledger.ts` directly and delete the method off the loop. Rejected for this step: it would change the orchestrator call site and its spec expectations (`this.toolLoop.isFalseSuccessReply` is asserted), turning a pure relocation into a cross-file edit with assertion churn. The one-line delegating method keeps the move byte-identical at the call site while still single-sourcing the patterns; collapsing the indirection is a follow-up, not this step.

## References

- The L4 tool-loop lift these helpers were moved with (step 5): [ADR 0034](0034-assistant-tool-loop-orchestration-layer.md)
- The narration re-drive the correction-driver and terminal-classifier serve (`unresolved` / corrective-nudge / `correction_exhausted`): [ADR 0009](0009-assistant-narration-redrive.md)
- The prior lifts in this sequence — session stores, reply/egress, conflict: [ADR 0031](0031-assistant-session-stores.md) · [ADR 0032](0032-assistant-reply-egress-layer.md) · [ADR 0033](0033-assistant-conflict-layer.md)
- The layered home (`orchestration/*`) and the migration step that splits these helpers out: [assistant-layered-architecture §layer model / §migration plan](../specs/assistant-layered-architecture.md#the-layer-model)
