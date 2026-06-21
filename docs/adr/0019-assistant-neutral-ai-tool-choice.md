# 0019 — assistant-neutral-ai-tool-choice

- **Status**: Accepted
- **Date**: 2026-06-20
- **Deciders**: @danil

## Context

The general `complete()` path never sets `tool_choice` today — `CompletionRequest` has no such field — so the model is always free to answer with prose ([ai-workflow §12](../specs/ai-workflow.md#12-model-roles--connector-abstraction-adr-0003--0007)). The only path that forces a specific tool is `completeStructured`. The narration re-drive ([ADR 0009](0009-assistant-narration-redrive.md), Story 1) needs to set `tool_choice: 'any'` for the **next round only** so a stalling model is nudged to actually call its tools instead of narrating. That primitive must exist on the connector before Story 1 can re-drive — it is the trio's prerequisite ([ADR 0018](0018-assistant-ai-comms-phase-b-scope-refinement.md)).

The connector is **provider-neutral** by [ADR 0007](0007-provider-connector-abstraction.md): no Anthropic shape may cross `ai.types.ts`. So the tool-choice control must be expressed in vendor-neutral terms and translated inside the connector.

This is the **connector half (Story 3a)** of backlog Story 3; the **529 → fallback-model swap (Story 3b)** is a separable decision and is **deferred** ([ADR 0018](0018-assistant-ai-comms-phase-b-scope-refinement.md)). This ADR records only the neutral `AiToolChoice`.

## Decision

Add a **vendor-neutral `AiToolChoice`** to the AI port and translate it in the connector:

- `ai.types.ts`: `export type AiToolChoice = 'auto' | 'any' | { name: string }`; add `toolChoice?: AiToolChoice` to `CompletionRequest`.
- The connector maps it in the existing `buildCreateParams` branch (the `completeStructured`-proven plumbing): `'any' → { type: 'any' }`, `{ name } → { type: 'tool', name }`, `'auto'`/unset → `undefined` (implicit `auto`, unchanged behaviour).
- **Degrade, never throw:** if the provider/model does not support forced tool calls, the connector drops to `undefined` rather than raising — a missing capability must never fail a turn.

The control is the connector's only job here. *When* to force (`'any'` for one round, the corrections cap, the read-instead-of-write risk) lives in the orchestrator/re-drive ([ADR 0009](0009-assistant-narration-redrive.md)), not here.

## Consequences

- ✅ Unblocks the narration re-drive (Story 1) — the loop can force a tool round without reaching into Anthropic shapes.
- ✅ Vendor-neutral: the `'auto' | 'any' | { name }` triple maps cleanly onto any provider's tool-choice model; ADR 0007's "no Anthropic shape crosses the port" holds.
- ✅ Additive and backward-compatible: a normal round omits `toolChoice`, so `tool_choice` stays absent (implicit `auto`) — existing behaviour is byte-unchanged, preserving the ADR 0004 cache prefix.
- ✅ Degrade-never-throw keeps the `attempts: 1` return-never-throw invariant intact even on an unsupported-tools provider.
- ⚠️ Forcing `'any'` can make a stalling model call a **read** instead of the intended write — that is bounded by the re-drive's corrections cap and the 5-fetch cap (ADR 0009), not by this connector control. `{ type: 'tool', name: 'create_task' }` is intentionally **not** the re-drive default (wrong when the intent was update/delete) — the `{ name }` variant exists for callers that genuinely want one specific tool.

## Alternatives considered

### Reuse `completeStructured` to force a tool

Rejected — `completeStructured` forces **one named** tool and is shaped for structured-output extraction. The re-drive wants `'any'` (call *some* tool), not a specific one; overloading the structured path would conflate two different contracts.

### Pass the raw Anthropic `tool_choice` object through `CompletionRequest`

Rejected — violates ADR 0007 (no provider shape crosses `ai.types.ts`). The neutral triple is the abstraction boundary.

### Fold this into ADR 0009 (the re-drive ADR)

Rejected — the connector capability is reused beyond re-drive (e.g. a future `ask_user` or any forced-tool caller) and is a distinct provider-abstraction decision under ADR 0007. One decision per file (per the doc conventions) keeps it independently evaluable.

## References

- Decision that consumes this: [ADR 0009](0009-assistant-narration-redrive.md) (narration re-drive sets `toolChoice: 'any'` for the next round)
- The phase scope placing 3a in the autonomous wave and deferring 3b: [ADR 0018](0018-assistant-ai-comms-phase-b-scope-refinement.md)
- Connector neutrality constraint: [ADR 0007](0007-provider-connector-abstraction.md)
- Current state: [ai-workflow §12](../specs/ai-workflow.md#12-model-roles--connector-abstraction-adr-0003--0007)
- Story 3 (shipped) as-built: [ai-workflow](../specs/ai-workflow.md)
