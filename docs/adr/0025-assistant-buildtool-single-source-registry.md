# 0025 — assistant-buildtool-single-source-registry

- **Status**: Accepted
- **Date**: 2026-06-20
- **Deciders**: @danil

## Context

Every assistant tool is defined **twice** today: a hand-written JSON schema in `ASSISTANT_TOOL_SCHEMAS` (`tools/tool-schemas.ts`) sent to the model, *and* a parallel Zod validator (`createTaskInputSchema`…) the dispatcher enforces ([ai-workflow §7.1](../specs/ai-workflow.md#71-tool-inventory-toolstool-schemasts)). The file even comments that the JSON "mirrors" the Zod — a standing drift hazard: a field can change in one and not the other, and the model then sees a schema the dispatcher rejects (or vice versa). The safety classifications `WRITE_TOOLS` / `SCHEDULE_FETCH_TOOLS` are likewise **hand-maintained `Set`s keyed by name** — forget to add a new write and the loop silently under-counts it (write accounting, the saved-count, and the success-integrity guard all key off `WRITE_TOOLS`).

Claude Code's `buildTool` (CC §3.2 — [research](/Users/danil/personal-projects/claude-code-src/AI_COMMS_TOOLSET_RESEARCH.md)) makes **one descriptor** the source of truth: a `BuiltTool` with a Zod `inputSchema`, fail-closed safety predicates, and a model-facing `prompt()` distinct from any UI `description()`. The API schema is then *derived*, not maintained alongside.

This is **Story 4 / Wave 2** of the deferred-stories execution plan ([ADR 0022](0022-deferred-ai-comms-stories-execution-plan.md)). It is dependency-free and **unblocks Story 7** (`check_availability`, Wave 3), which needs the registry to classify itself read/schedule-fetch. It was deferred from the autonomous wave by [ADR 0018](0018-assistant-ai-comms-phase-b-scope-refinement.md) precisely because it is large correctness-neutral churn over nine working handlers — exactly the kind of refactor that wants a human gate.

## Decision

Each tool is defined **once** as a `BuiltTool` via `buildTool(def)`, and everything the model and the dispatcher consume is **derived** from that single descriptor.

- **`buildTool(def) = { ...TOOL_DEFAULTS, ...def }` — defaults spread first.** Omitted predicates fall back to the **safe** value, so `isWrite` / `isReadOnly` are **fail-closed**: a tool that forgets to declare itself read-only is treated as a write (counted, guarded), never the reverse.
- **The Anthropic API schema is derived** — `{ name, description: await tool.prompt(), input_schema: zodToJsonSchema(tool.inputSchema) }` — with **no separately-maintained JSON block**. The JSON the model sees is *generated* from the Zod the dispatcher enforces, so the two can no longer disagree. (Zod v4 `z.toJSONSchema()` is the derivation bridge; every Zod field carries `.describe()` per [ADR 0016](0016-assistant-ai-comms-audit-hardening.md) so the derived JSON is **at least as descriptive** as today's hand-written block.)
- **`WRITE_TOOLS` / `SCHEDULE_FETCH_TOOLS` are derived** from `registry.writeNames()` / `registry.readNames()` — not hand-maintained `Set`s. Adding a tool to the registry classifies it automatically; the "forgot to add to the Set" drift is closed structurally.
- **Tool order stays stable** — new tools are **appended, never reordered** — so [ADR 0004](0004-assistant-prompt-composition-and-caching.md) cache breakpoint #1 survives: the tools prefix re-baselines **once** when the migrated/added tools land, then stays byte-stable.
- **Model-facing `prompt()` and any UI-facing `description()` are distinct fields** (don't swap them).
- **The dispatcher thins to `safeParse` + `registry.run()`.** Existing behaviour is unchanged: a Zod validation failure still becomes a *recoverable* `tool_result` the model can correct, not a crash.

New surface: `tools/tool.contract.ts` (`Tool<Input,Output>` + fail-closed `TOOL_DEFAULTS`), `tools/build-tool.ts` (`buildTool(def)`), `tools/tool-registry.ts` (`name→BuiltTool`, `toSchemas()`, `writeNames()`, `readNames()`). The nine existing handlers migrate into `definitions/*.tool.ts` **one tool per PR**, old + new side-by-side; `ask_user` / `create_tasks` / `check_availability` are authored as `buildTool` natively.

**The migration is behaviour-preserving** — the model sees the same tools, the dispatcher enforces the same shapes, the safety sets resolve to the same names; **all existing tests stay green** at every step. ToolSearch / `defer_loading` and MCP tool support remain **out of scope** ([ADR 0018](0018-assistant-ai-comms-phase-b-scope-refinement.md)) — irrelevant at ~12 tools.

## Consequences

- ✅ **No JSON↔Zod drift, structurally.** The model can never be sent a schema the dispatcher rejects, because there is only one schema.
- ✅ **Safety classification can't silently rot.** A new tool is `isWrite` until it proves otherwise (fail-closed defaults), and the WRITE/READ sets derive from the registry, so write accounting / saved-count / the success-integrity guard stay correct without a second edit.
- ✅ **Unblocks Story 7** — `check_availability` declares itself read/schedule-fetch through the registry instead of being added to a hand-kept `Set`; Stories 2/5/7's tool authoring simplifies to one descriptor each.
- ✅ **Cache prefix preserved** — appended-not-reordered keeps ADR-0004 breakpoint #1 warm after a single re-baseline.
- ✅ **Migration is bisectable and low-blast-radius** — one tool per PR, old + new side-by-side, every PR lint+type+jest-green.
- ⚠️ **Large correctness-neutral churn over nine working handlers.** Touching code that already works carries regression risk for zero user-visible gain; mitigated by the one-per-PR / side-by-side discipline and the "all tests stay green" invariant. It is reasonable to defer the last few handlers if the value has been captured.
- ⚠️ **The derived JSON must be verified at least as descriptive as the hand-written block** (a PR check), since the model-steering descriptions that today live only in the JSON now must live in `.describe()` on every Zod field — a missed `.describe()` is a silent prompt regression, not a build error.
- ⚠️ **Zod-v4-`toJSONSchema()` dependence** — the derivation correctness now rides on the Zod→JSON-Schema mapping; an unsupported Zod construct could produce a schema the model reads differently than intended (caught by the descriptiveness PR check + existing dispatcher tests).

## Alternatives considered

### Keep the double definition (hand-written JSON + parallel Zod)

The status quo. Rejected — it is the drift hazard itself: two artifacts that must be kept in lockstep by hand, with no compiler or test forcing them to agree, plus the parallel hand-maintained `WRITE_TOOLS`/`SCHEDULE_FETCH_TOOLS` `Set`s. The whole point of Story 4 is to make one descriptor authoritative; preserving the double definition preserves the exact problem.

### Full MCP-style `Tool` with renderers (UI render methods, `defer_loading`, ToolSearch)

Rejected — over-built for ~12 tools. CC's full Tool contract carries UI renderers and a deferral/search mechanism for large tool catalogs; at this scale ToolSearch / `defer_loading` add machinery with no payoff (a flat `tools[]` array every turn is well under any bloat threshold), and MCP tool support is explicitly out of scope ([ADR 0018](0018-assistant-ai-comms-phase-b-scope-refinement.md)). We adopt only the source-of-truth core: Zod `inputSchema`, fail-closed predicates, `prompt()` vs `description()`. The `description()` field is kept distinct now so a future UI surface is cheap, without paying for renderers today.

### Derive the Zod from the JSON instead (JSON as source of truth)

Rejected — the dispatcher needs runtime parsing and recoverable errors, which Zod gives natively; reconstructing a Zod validator from JSON Schema is lossy (refinements, `.max()`, custom messages) and would weaken the very validation that produces correctable `tool_result`s. Zod is the richer source; the JSON is the cheap projection.

## References

- Story 4 (shipped) as-built: [ai-workflow](../specs/ai-workflow.md)
- Deep design — *Does the tool set change?* (single source of truth) + the file layout: [assistant-layered-architecture](../specs/assistant-layered-architecture.md#does-the-tool-set-sent-to-the-model-change)
- Cache breakpoint #1 the stable order preserves: [ADR 0004](0004-assistant-prompt-composition-and-caching.md)
- Every-field-`.describe()` requirement: [ADR 0016](0016-assistant-ai-comms-audit-hardening.md)
- Scope boundary (ToolSearch / MCP out): [ADR 0018](0018-assistant-ai-comms-phase-b-scope-refinement.md)
- The wave plan placing this at Wave 2, unblocking Story 7: [ADR 0022](0022-deferred-ai-comms-stories-execution-plan.md)
- Current state of the tool inventory + the hand-maintained sets: [ai-workflow §7.1](../specs/ai-workflow.md#71-tool-inventory-toolstool-schemasts)
- Pattern source: `/Users/danil/personal-projects/claude-code-src/AI_COMMS_TOOLSET_RESEARCH.md` (§3.2 Tool)
