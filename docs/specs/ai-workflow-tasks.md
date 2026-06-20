# AI workflow — task backlog (canonical)

- **Status**: Backlog — ready-to-pick stories. Update as stories ship (move to Done, link the PR).
- **Scope**: Two milestones — **v1 Foundation** (Stories 1–9: loop correctness, `ask_user`, the layered refactor) and **v2 Conversational UX** (Stories 10–18: live status message, native streaming, message debounce/coalescing, AI-judged conflicts, bot controls, daily reports, per-user personality). **v2 is a new application version that sits on the v1 foundation.**
- **Last updated**: 2026-06-20
- **Owner**: @danil
- **Current state it evolves**: **[ai-workflow](ai-workflow.md)** (what ships today)
- **Deep designs**: [assistant-layered-architecture](assistant-layered-architecture.md) · [assistant-tool-loop-redrive](assistant-tool-loop-redrive.md) · [assistant-task-tools](assistant-task-tools.md) · [recurrence-expansion](recurrence-expansion.md) · **[ai-workflow-v2-research](ai-workflow-v2-research.md)** (verified Telegram + cue-api recon dossier for v2)
- **Decision records**: [ADR 0009 — narration re-drive](../adr/0009-assistant-narration-redrive.md) · [ADR 0010 — stateful ask_user resume](../adr/0010-assistant-ask-user-stateful-resume.md) · [ADR 0006 — conflicts](../adr/0006-assistant-schedule-context-and-conflicts.md) · [ADR 0007 — connector](../adr/0007-provider-connector-abstraction.md) · [ADR 0017 — Phase B = Stories 1–9](../adr/0017-assistant-ai-comms-implementation-scope.md) · [ADR 0018 — Phase B scope refinement (autonomous wave = trio 3a/1/2; rest deferred)](../adr/0018-assistant-ai-comms-phase-b-scope-refinement.md) · [ADR 0019 — neutral `AiToolChoice`](../adr/0019-assistant-neutral-ai-tool-choice.md) · [ADR 0022 — deferred-stories execution plan (6 waves; supersedes 0018's deferral)](../adr/0022-deferred-ai-comms-stories-execution-plan.md) · [ADR 0023 — 529 → fallback model](../adr/0023-assistant-529-fallback-model.md) · [ADR 0024 — recurring-conflict hold](../adr/0024-assistant-recurring-conflict-hold.md) · [ADR 0025 — buildTool single-source registry](../adr/0025-assistant-buildtool-single-source-registry.md) · [ADR 0029 — check_availability batch read](../adr/0029-assistant-check-availability-batch-read.md) · [ADR 0030 — inbound 4-flow router + turn-runner convergence](../adr/0030-assistant-inbound-flow-router-turn-runner.md)

---

## Milestone v1 — Foundation (loop correctness · `ask_user` · layered refactor)

> This is the foundation milestone. **[Milestone v2 — Conversational UX](#milestone-v2--conversational-ux-this-enhancement)** is further down and builds on it.

**Where we are.** The assistant works (webhook → BullMQ → tool loop → reply, with caching, memory, schedule layers, a conflict hold, and a success-integrity guard — see [ai-workflow](ai-workflow.md)). But it has one **confirmed production bug** (it narrates a batch action and saves nothing — [ai-workflow §13](ai-workflow.md#13-known-failure-mode-today--narration-without-writing)) and it **cannot ask a clarifying question and resume** — a question is plain text and the next turn lossily reconstructs intent.

**Where we want to be, and why.** Adopt the proven Claude Code communication patterns (source: `AI_COMMS_TOOLSET_RESEARCH.md`) so the assistant **feels like a person**: it asks questions with tappable options *or* free text and seamlessly continues; it never claims an action it didn't perform; tools are defined once (no schema drift); and the whole thing lives in a clean layered architecture instead of one god-service.

**Locked decisions** (carried from the design specs):
- Full Claude Code pattern adoption — content-scan continue-signal (distrust `stop_reason`), `buildTool` contract, `withRetry` transport, `ask_user`, structured-output discipline.
- Re-drive loop **+ batch `create_tasks`**; escalation = structured log **+ real alert sink**.
- `ask_user` = **stateful, durable** suspend/resume (Postgres system-of-record + Redis 30-min hot index).
- Dispatch stays **serial, in emission order** (deliberate divergence from CC read-parallelism — deterministic write order for one calendar).

### Stories at a glance (suggested order)

> **Autonomous Phase-B wave SHIPPED ([ADR 0018](../adr/0018-assistant-ai-comms-phase-b-scope-refinement.md)).** The unattended run shipped **only the loop-correctness trio** that fixes the confirmed §13 bug — **Story 3a (`AiToolChoice`, [ADR 0019](../adr/0019-assistant-neutral-ai-tool-choice.md))** → **Story 1 (narration re-drive, [ADR 0009](../adr/0009-assistant-narration-redrive.md))** → **Story 2 (batch `create_tasks`, [ADR 0020](../adr/0020-assistant-batch-create-tasks.md))** — each gated by lint + type + jest. This refines (does not supersede) ADR 0017's "Phase B = Stories 1–9".

> **Deferred-stories execution plan AUTHORIZED ([ADR 0022](../adr/0022-deferred-ai-comms-stories-execution-plan.md)).** The user authorized implementing the previously-deferred stories (3b, 4, 5, 6, 7, 8, 9) **under human review**, in **six dependency-ordered waves**, each gated by lint + type + jest and each carrying its own ADR. This **supersedes ADR 0018's deferral** of these stories.
>
> | Wave | Stories | Why this position |
> |---|---|---|
> | **1** | **3b** ([ADR 0023](../adr/0023-assistant-529-fallback-model.md)) **+ 9** ([ADR 0024](../adr/0024-assistant-recurring-conflict-hold.md)) — **parallel** | both standalone, dependency-free, touch disjoint code (connector transport vs dispatcher write path) |
> | **2** | **4** — `buildTool` single-source registry | unblocks 7; independent |
> | **3** | **7** — `check_availability` | needs Wave 2's registry classification |
> | **4** | **6** — inbound 4-flow router + turn-runner | routes the typed-answer flow Story 5 needs |
> | **5** | **5** — `ask_user` durable suspend/resume | needs Wave 4's router to deliver the answer |
> | **6** | **8** — layered decomposition | the god-service lift goes last; hosts 1–7 as behaviour-preserving migration steps |

| # | Story | Ships | Depends on | Decision | Status |
|---|---|---|---|---|---|
| 3a | **Connector: neutral `AiToolChoice`** | forced tool calls | — | [ADR 0019](../adr/0019-assistant-neutral-ai-tool-choice.md) | **SHIPPED — autonomous wave** |
| 1 | **Narration re-drive + escalation sink** | the bug fix | 3a (toolChoice) | [ADR 0009](../adr/0009-assistant-narration-redrive.md) | **SHIPPED — autonomous wave** |
| 2 | **Batch `create_tasks` tool** | token-efficient "create N" | — | [ADR 0020](../adr/0020-assistant-batch-create-tasks.md) | **SHIPPED — autonomous wave** |
| 3b | **Connector: 529 → fallback-model swap** | survive overload | — | [ADR 0023](../adr/0023-assistant-529-fallback-model.md) | **IN PROGRESS — Wave 1 (parallel with 9)** |
| 9 | **Close write-side recurring-conflict gap** | safety fix | — | [ADR 0024](../adr/0024-assistant-recurring-conflict-hold.md) | **IN PROGRESS — Wave 1 (parallel with 3b)** |
| 4 | **`buildTool` contract + single-source Zod** | kills schema drift | — | layered §"tool set" | **PLANNED — Wave 2** |
| 7 | **`check_availability` batch read tool** | check 10 slots in one call | 4 (registry) | [ADR 0029](../adr/0029-assistant-check-availability-batch-read.md) | **IN PROGRESS — Wave 3** |
| 6 | **Inbound 4-flow router + turn-runner** | routes answers; convergence | — | [ADR 0030](../adr/0030-assistant-inbound-flow-router-turn-runner.md) | **IN PROGRESS — Wave 4** |
| 5 | **`ask_user` + durable suspend/resume** | the "feel human" feature | 6 (router) | [ADR 0010](../adr/0010-assistant-ask-user-stateful-resume.md) | **IN PROGRESS — Wave 5 (new DB subsystem)** |
| 8 | **Layered decomposition** | structural home for 1–7 | 1–7 land inside it | layered migration | **PLANNED — Wave 6 (largest refactor)** |

> **Sequencing note.** The autonomous wave shipped the trio **3a → 1 → 2** (1 wants 3a's `toolChoice` first; 2 makes the re-driven "create N" call trivially correct). The original Story 3 is split: **3a (neutral `AiToolChoice`)** shipped in that wave; **3b (529 → fallback)** is now **Wave 1** of the deferred plan ([ADR 0023](../adr/0023-assistant-529-fallback-model.md)). The remaining deferred stories run in the six waves above ([ADR 0022](../adr/0022-deferred-ai-comms-stories-execution-plan.md)): Wave 1 lands the two dependency-free fixes (3b + 9) in parallel; then 4 → 7 (registry first), 6 → 5 (router before the answer store), and Story 8 last — not a big-bang rewrite but the *vehicle* for 1–7, each landing as a behaviour-preserving lift inside the layered move.

---

## Story 1 — Narration re-drive (validate → feedback → retry ≤5 → escalate)

> **Phase-B status: IN PROGRESS — landing this autonomous wave ([ADR 0018](../adr/0018-assistant-ai-comms-phase-b-scope-refinement.md)).** Depends on **Story 3a** (`AiToolChoice`), which lands first in the same wave.

### Story
As a **Cue user**, I want the assistant to **actually create what it says it will** so that "create all seven driving lessons" never silently saves nothing.

### Context / Why now
Confirmed production failure: the model returns `end_turn` + *"Создаю все семь…"* + **zero tool calls**; the loop relays the text and nothing is written ([ai-workflow §13](ai-workflow.md#13-known-failure-mode-today--narration-without-writing)). The current `isFalseSuccessReply` guard *detects* the lie but **never re-drives** the model. Design: [assistant-tool-loop-redrive](assistant-tool-loop-redrive.md) · decision: [ADR 0009](../adr/0009-assistant-narration-redrive.md).

> **Accepted-hardening carve-out ([ADR 0016](../adr/0016-assistant-ai-comms-audit-hardening.md) · [ai-comms audit A1](ai-comms-cc-audit.md)).** The **terminal-handling overhaul** ships as Phase A accepted-hardening ahead of this story: (1) the **continue-signal gate removal** — driving the loop's continue decision off a **content scan** (`toolCalls.length > 0`) instead of the `stopReason !== TOOL_USE` gate; and (2) the **honest terminal branch** on a no-tool-call turn (`MAX_TOKENS` → "had to cut that short", `REFUSAL` → honest decline, else → text), splitting today's overloaded `?? ROUNDTRIP_CEILING_REPLY`. The **full narration re-drive** (classify → corrective user message → forced `tool_choice:'any'` → retry ≤5 → escalate), which sits on the `END_TURN`-with-zero-commits-and-zero-writes branch, **remains Story 1**.

### Acceptance Criteria
- [ ] Given a turn with **zero tool calls, zero commits, and not a question**, when it terminates, then the loop appends a corrective **user** message, sets `tool_choice:'any'` for the **next round only**, and re-invokes the model (instead of returning the text).
- [ ] Given the re-drive emits the `create_task` calls, when they commit, then the user gets the prepared success message and `committedWrites > 0`.
- [ ] Given a **genuine clarifying question** at round 0 (`CLAIM_VETO_PATTERN` match, or any unforced question), when it terminates, then it passes through unchanged — **never** forced to write, never re-driven.
- [ ] Given `committedWrites > 0` (incl. partial "5 of 7"), then the turn is `genuine` — no re-drive.
- [ ] Given `corrections` reaches `ASSISTANT_MAX_CORRECTIONS` (default 5, strictly `< ASSISTANT_MAX_TOOL_ROUNDTRIPS`), then the turn returns `kind:'unresolved'` → a structured `assistant.correction_exhausted` log **+ alert sink** + an honest reply; it **does not throw**.
- [ ] Given `ASSISTANT_MAX_CORRECTIONS = 0`, then re-drive is disabled and today's detect-and-mask guard behaviour is restored (kill-switch).
- [ ] The corrective nudge is a plain user `PromptBlock`, **never** a synthetic `ToolRound` (a fabricated `tool_result` with no matching `tool_use` is an Anthropic 400).

### Out of scope
- Re-planning **time conflicts** by re-invoking the model — that stays the deterministic ADR-0006 hold (a *clashing* action ≠ *no* action).
- Fixing the §10 guard's regex coverage as the primary mechanism — the trigger is **structural** (zero tools + zero commits + not-a-question); the regex is demoted to a logging hint.
- Partial-batch ("5 of 7 committed") recovery — `committedWrites > 0` short-circuits to genuine.

### Technical notes
- Replaces the unconditional terminal return at `assistant.service.ts:350-363` with `classifyTerminalTurn(text, committedWrites, attemptedWrites) → genuine | narration_without_write`. Veto is the hard floor; `MUTATION_CLAIM_PATTERN` only sets `correctionReason` for logging (closes the EN-gerund blind spot).
- Needs `toolChoice` on the connector — **depends on Story 3**.
- Types: extend `LoopOutcome` with `{ kind:'unresolved'; corrections; attemptedWrites; lastErrors }`; add `correctionReason?: 'claim_without_writes' | 'writes_errored'` to `ToolRoundAuditPayload` (greppable — measure re-drive frequency before/after).
- Alert sink: thin `AlertConnector` (ADR-0007 style: base + factory + `SentryAlertConnector` + dev no-op); first event `assistant.correction_exhausted`. Roll out with the audit field first to measure false-positive rate before tuning.
- Flags: `ASSISTANT_MAX_CORRECTIONS` (Zod, default 5).
- Design: [assistant-tool-loop-redrive](assistant-tool-loop-redrive.md).

### Dependencies / Risks
- **Blocked by Story 3** (`AiToolChoice` on the connector).
- Risk: a forced `'any'` can make a stalling model call a *read* instead of the write — bounded by the corrections cap + 5-fetch cap, it terminates into escalation rather than looping. `{type:'tool', name:'create_task'}` rejected as too strong (wrong when intent was update/delete).
- Risk: "no throw" escalation is correct **only** while the queue is `attempts:1`; if attempts is ever raised, convert to a BullMQ `UnrecoverableError` (recorded in ADR 0009).

---

## Story 2 — Batch `create_tasks` tool

> **Phase-B status: IN PROGRESS — landing this autonomous wave, after Story 1 ([ADR 0018](../adr/0018-assistant-ai-comms-phase-b-scope-refinement.md)).** Completes the loop-correctness trio (3a → 1 → 2) that fixes the confirmed §13 bug. Decision: [ADR 0020](../adr/0020-assistant-batch-create-tasks.md).

### Story
As a **Cue user**, I want "create these seven lessons" to be **one** assistant action so that batch creates are reliable and cheap.

### Context / Why now
There is no batch create today — N tasks = N `create_task` calls, which is exactly the cognitive load that tips the model into narration (Story 1). A batch tool makes the re-driven call trivially correct ("create all seven" → one call) and cuts tokens. Design: [assistant-tool-loop-redrive §Batch](assistant-tool-loop-redrive.md) · [assistant-task-tools](assistant-task-tools.md).

### Acceptance Criteria
- [ ] Given `create_tasks([...])` with `z.array(createTaskInputSchema).min(1).max(25)`, when dispatched, then it fans out to `TaskService.create` **in input order** and returns a structured per-item result (`created` handle / `error` / `held`).
- [ ] Given one item in the batch conflicts, when dispatched, then that item routes through the **existing batch-hold path** while the rest commit (no whole-batch abort).
- [ ] Given an array over the cap, then the tool returns a recoverable result asking the model to split — not a crash.
- [ ] `create_tasks` is a `WRITE_TOOLS` member; each committed item counts toward `committedWrites`.

### Out of scope
- Batch update/delete/complete (only create batches now).
- Changing the held-conflict UX — reuses the existing batch-hold keyboard.

### Technical notes
- New schema + Zod array validator + dispatcher fan-out; additive. Touches `tools/tool-schemas.ts`, `tool-dispatcher.service.ts`. Authored natively as a `buildTool` once Story 4 lands (until then, parallels the existing pattern).
- **Schema appended last** in `tools/tool-schemas.ts` (never inserted mid-list) to preserve ADR-0004 cache breakpoint #1 — the shared tool prefix re-baselines once, then stays byte-stable ([ADR 0020](../adr/0020-assistant-batch-create-tasks.md)).
- `ToolDispatchOutcome` gains optional **plural** `heldConflicts?` + `committed`/`attempted` counts; `runToolLoop` increments `committedWrites`/`attemptedWrites` by the per-call counts, **falling back to the singular `+1`** for non-batch tools. Conflicting items reuse the **existing ADR-0006 held path** (no new mechanism) and confirm via the existing batch-hold keyboard.
- Cap decision (≤25) is an open question — see Risks.

### Dependencies / Risks
- Independent; pairs naturally with Story 1 (ship both — batch reduces narration, re-drive eliminates it).
- Open: final array cap (≤25 proposed) before asking the user to split.

---

## Story 3 — Connector: `AiToolChoice` + `withRetry` transport

> **Phase-B split ([ADR 0018](../adr/0018-assistant-ai-comms-phase-b-scope-refinement.md)).** This story is split into two:
> - **Story 3a — neutral `AiToolChoice`** (the connector half): **SHIPPED — autonomous wave** (prerequisite for Story 1). Decision: [ADR 0019](../adr/0019-assistant-neutral-ai-tool-choice.md).
> - **Story 3b — 529 → fallback-model swap**: **IN PROGRESS — Wave 1 of the deferred-stories execution plan ([ADR 0022](../adr/0022-deferred-ai-comms-stories-execution-plan.md)), parallel with Story 9.** Decision: [ADR 0023](../adr/0023-assistant-529-fallback-model.md) — on sustained 529/overload of the MAIN model (after the SDK's retries) retry once on the BACKGROUND (Haiku) model id (no new env var), degrade-never-throw to `AI_FAILURE_REPLY` if Haiku also fails; only MAIN gets a fallback; 529 = status 529 **OR** `"overloaded_error"` substring.
>
> The acceptance criteria below are tagged 3a / 3b accordingly.

### Story
As a **developer**, I want the connector to **force a tool call when asked** (3a, this wave) and **survive overload** (3b, deferred), so that re-drive can nudge the model and a 529 never surfaces to the user.

### Context / Why now
`complete()` never sets `tool_choice` today (Story 1 needs it). Transport retry is handled by the SDK's built-in `maxRetries` (exp backoff + jitter + `Retry-After` + 5xx/429) — good, but it retries the **same** model on 529/overload with **no fallback**. CC's two-tier strategy (CC §3.4) adds a 529 → fallback-model swap. Design: [assistant-layered-architecture §10 / §patterns](assistant-layered-architecture.md).

> **Accepted-audit priority ([ai-comms audit §B](ai-comms-cc-audit.md), [ADR 0017](../adr/0017-assistant-ai-comms-implementation-scope.md)).** The **529 → fallback-model swap is the single highest-value failure-handling item for Phase B** — under `attempts:1` a sustained main-model overload is otherwise a dead turn. Centralize 529 detection in **one exported `is529()` helper** (`status === 529` **OR** the body substring `"type":"overloaded_error"` — the SDK can drop the status mid-stream), consumed by **both** the fallback decision and `describeAnthropicError` (`anthropic-ai.connector.ts:430-451`, which today has no 529 branch), with a focused unit spec (status-529 · status-dropped body-string · neither). The swap sits **above** the SDK retries and degrades to today's terminal-error reply if the fallback also fails.

### Acceptance Criteria
- [ ] **(3a — this wave)** Given `CompletionRequest.toolChoice = 'any' | { name } | 'auto'`, when `complete()` runs, then the connector translates it (`'any' → {type:'any'}`, `{name} → {type:'tool',name}`, `'auto'/unset → undefined`) and **degrades to undefined** (never throws) if tools are unsupported.
- [ ] **(3b — Wave 1, [ADR 0023](../adr/0023-assistant-529-fallback-model.md))** Given sustained 529/overload of the **MAIN** model **after** the SDK's built-in retries exhaust, when detected (status 529 **OR** `"overloaded_error"` substring, via one exported `is529()`), then the connector retries the turn **once on the BACKGROUND (Haiku) model id** (no new env var — reuses `ASSISTANT_MODEL_BACKGROUND`); if Haiku also fails it **degrades-never-throws** to today's `AI_FAILURE_REPLY` — the loop never sees a 529. Only the MAIN role gets a fallback.
- [ ] **(3a — this wave)** Given a normal round, then `tool_choice` is absent (implicit `auto`) — unchanged behaviour.
- [ ] **(3a — this wave)** The translation + degradation paths are unit-tested. **(3b — deferred)** the 529 fallback paths are unit-tested.

### Out of scope
- Hand-rolling the full CC `withRetry` generator — the SDK already covers transport backoff; we only add the 529 → model-fallback the SDK lacks.
- A second LLM provider.

### Technical notes
- `ai.types.ts`: `export type AiToolChoice = 'auto' | 'any' | { name: string }`; add `toolChoice?: AiToolChoice` to `CompletionRequest`. Vendor-neutral; connector maps in the existing `buildCreateParams` branch (reuses `completeStructured`-proven plumbing).
- 529 is matched by **status 529 OR** the substring `"type":"overloaded_error"` (the SDK sometimes drops the status mid-stream).
- Optional: a dedicated `with-retry.ts` wrapper if we want the fallback logic outside the SDK; otherwise extend the connector. Flag: a fallback-model env if not already present.

### Dependencies / Risks
- **Unblocks Story 1.** Independent of all others.
- Low risk — additive, vendor-neutral, degrade-never-throw.

---

## Story 4 — `buildTool` contract + single-source Zod schemas

> **Status: IN PROGRESS — Wave 2 of the deferred-stories execution plan ([ADR 0022](../adr/0022-deferred-ai-comms-stories-execution-plan.md)); decision recorded in [ADR 0025](../adr/0025-assistant-buildtool-single-source-registry.md).** Independent; unblocks Story 7 (Wave 3). Large correctness-neutral churn over 9 working handlers — land one tool per PR, gated by lint + type + jest, human-reviewed (was deferred from the autonomous wave by [ADR 0018](../adr/0018-assistant-ai-comms-phase-b-scope-refinement.md)).

### Story
As a **developer**, I want each tool defined **once** so that the JSON the model sees can never drift from the Zod the dispatcher enforces.

### Context / Why now
Today every tool is defined **twice** — a hand-written JSON schema in `ASSISTANT_TOOL_SCHEMAS` *and* a parallel Zod validator (`createTaskInputSchema`…) — a standing drift hazard (the file even comments that the JSON "mirrors" the Zod). The `WRITE_TOOLS`/`SCHEDULE_FETCH_TOOLS` sets are likewise hand-maintained, keyed by name (forget to add → silent miscount). CC's `buildTool` (CC §3.2) makes one descriptor the source of truth. Design: [assistant-layered-architecture §"Does the tool set change?"](assistant-layered-architecture.md#does-the-tool-set-sent-to-the-model-change).

### Acceptance Criteria
- [ ] Given a tool defined as a `BuiltTool` with a Zod `inputSchema`, when the prompt is assembled, then the API schema is **derived** — `{ name, description: await tool.prompt(), input_schema: zodToJsonSchema(tool.inputSchema) }` — with no separately-maintained JSON block.
- [ ] Given `buildTool(def)`, then defaults are spread **first** (`{ ...TOOL_DEFAULTS, ...def }`) so omitted predicates are **fail-closed** (`isWrite`/`isReadOnly` default to the safe value).
- [ ] Given the registry, then `WRITE_TOOLS` / `SCHEDULE_FETCH_TOOLS` are **derived** from `registry.writeNames()` / `readNames()` — not hand-maintained.
- [ ] Tool **order is stable** (new tools appended, never reordered) so the ADR-0004 cache breakpoint #1 survives; the tools prefix re-baselines **once** when new tools land, then stays byte-stable.
- [ ] Model-facing `prompt()` and any UI-facing `description()` are distinct fields (don't swap them).
- [ ] **Every Zod field carries `.describe()`** ([ADR 0016](../adr/0016-assistant-ai-comms-audit-hardening.md)) so `z.toJSONSchema()` preserves the model-steering descriptions that today live only in the hand-written JSON block — the derived JSON is **at least as descriptive** as today's block (PR check).
- [ ] Existing dispatcher behaviour (Zod safeParse → recoverable `tool_result` on failure) is unchanged.

### Out of scope
- ToolSearch / `defer_loading` — irrelevant at ~12 tools (explicitly **not** adopted).
- MCP tool support, two-partition MCP sort.

### Technical notes
- New `tools/tool.contract.ts` (`Tool<Input,Output>` + fail-closed defaults), `build-tool.ts`, `tool-registry.ts` (`name→BuiltTool`, `toSchemas()`, `writeNames()`/`readNames()`); dispatcher thins to `safeParse + registry.run()`.
- Migrate the 9 existing handlers into `definitions/*.tool.ts` **one tool per PR**, old+new side-by-side — correctness-neutral churn; reasonable to defer the last few. `ask_user`/`create_tasks`/`check_availability` are authored natively as `buildTool`.
- Zod v4 `z.toJSONSchema()` is the derivation bridge.

### Dependencies / Risks
- Independent; **unblocks Story 7** (registry) and simplifies Stories 2/5/7's tool authoring.
- Risk: churn over 9 working handlers — mitigate with one-per-PR, side-by-side.

---

## Story 5 — `ask_user` with durable, stateful suspend/resume

> **Status: IN PROGRESS — landing Wave 5 of the deferred-stories execution plan ([ADR 0022](../adr/0022-deferred-ai-comms-stories-execution-plan.md)); implements [ADR 0010](../adr/0010-assistant-ask-user-stateful-resume.md) (already Accepted).** Depends on Wave 4 (Story 6's router, which delivers the typed-answer flow). Introduces a **new durable DB subsystem** (entity + migration + Redis hot index + compare-and-set) + a `@nestjs/schedule` expiry job — gated by lint + type + jest, human-reviewed (was deferred from the autonomous wave by [ADR 0018](../adr/0018-assistant-ai-comms-phase-b-scope-refinement.md)). As-built behaviour: [ai-workflow §9a](ai-workflow.md#9a-ask_user-suspend--resume-adr-0010--story-5).

### Story
As a **Cue user**, I want the assistant to **ask me a question — with buttons or just by typing — and then pick up exactly where it left off**, so that it feels like a person, not a form.

### Context / Why now
Today a question is plain text and the next turn reconstructs intent from history (lossy — the seam where the narration bug lives). On an async Telegram pipeline there is no live loop to pause, so a question must **end the turn** and resume on a later webhook (possibly hours later, possibly after a restart). Design: [assistant-layered-architecture §suspend/resume](assistant-layered-architecture.md#suspend--resume-state-machine) · decision: [ADR 0010](../adr/0010-assistant-ask-user-stateful-resume.md).

### Acceptance Criteria
- [ ] Given the model calls `ask_user({ question, options?: {id,label}[].max(4) })`, when dispatched, then the turn **suspends** (`LoopOutcome.ask`) and `call()` touches **no DB**.
- [ ] Given `options` are omitted, then the user sees a plain text question (no buttons) and a typed reply resumes; given 2–4 options, then a quick-reply keyboard is shown and a tap resumes.
- [ ] Given suspension, then the session (`toolRounds` incl. the assistant round carrying the `ask_user` `tool_use` **but not** its `tool_result`, `askToolUseId`, `optionLabels`, `question`, `correlationId`, `vendorChatId`) is written **durably to Postgres** (`pending_question`, status `AWAITING`) **and** mirrored to Redis (`assistant:ask:*`, TTL 30 min).
- [ ] Given a **button tap** carrying the row id (`ask:<pending_question_id>:<opt>`), when it arrives any time within `ASSISTANT_ASK_USER_RETENTION_HOURS` (default 168), then the turn **resumes from Postgres** (even after the Redis TTL / a restart).
- [ ] Given a **free-text** reply, when it arrives **inside** the 30-min hot window, then it resumes as the answer; when it arrives **after**, then it starts a **fresh** turn (never silently consumed as a stale answer).
- [ ] Given resume, then exactly **one** synthetic `{ toolCallId: askToolUseId, content: answer }` is appended and the model is **re-invoked** (it may suspend again) — no interleaved/unpaired block (Anthropic 400).
- [ ] Given two concurrent answers, then the **atomic claim** (`Redis GETDEL` hot **or** `UPDATE … SET status='ANSWERED' WHERE id=? AND status='AWAITING' RETURNING *`) lets only one resume; zero rows ⇒ already resumed ⇒ ignore.
- [ ] A partial-unique index `(conversationId) WHERE status='AWAITING'` enforces ≤1 open question per conversation.

### Out of scope
- Re-invoking the model to resolve a **time conflict** — that stays the deterministic ADR-0006 path (`held_conflict`, Redis-only, `confirm:`/`cancel:` prefix). `ask_user` is a *different* mechanism (`pending_question`, `ask:` prefix, re-invokes the model).
- Free-text resume **after** the hot window (deliberately unsupported — ambiguity).
- A per-user advisory lock (deferred; the compare-and-set already blocks double-resume).

### Technical notes
- New entity `pending_question` (`conversationId` FK cascade, `askToolUseId`, `payload` jsonb, `status` `AWAITING|ANSWERED|CANCELLED|EXPIRED`, `expiresAt`, timestamps) → repository → `PendingQuestionDatabaseService` → migration (partial-unique + `(status,expiresAt)` index). Strict 3-layer data access.
- `redis.constants.ts`: `pendingQuestionKey(userId)` beside `heldConflictKey` (one file ⇒ disjointness auditable).
- `@nestjs/schedule` cleanup job marks expired `AWAITING` rows `EXPIRED` (hygiene/metrics; correctness already held by the compare-and-set).
- Flags: `ASSISTANT_ASK_USER_TTL_SECONDS=1800`, `ASSISTANT_ASK_USER_RETENTION_HOURS=168`.
- `ask-user.tool.ts` authored as `buildTool` (Story 4). Routing of the answer is **Story 6**.
- As-built suspend/resume machine (durable `pending_question` + Redis hot-mirror + atomic claim + `@nestjs/schedule` expiry job): [ai-workflow §9a](ai-workflow.md#9a-ask_user-suspend--resume-adr-0010--story-5).

### Dependencies / Risks
- **Depends on Story 6** (the router must detect "typed message while a question is pending") and **Story 3** is adjacent (toolChoice not required, but ships together).
- Risk: two inbound updates while pending race (last-writer-wins) — compare-and-set blocks double-resume; advisory lock deferred.

---

## Story 6 — Inbound 4-flow router + turn-runner convergence

> **Status: IN PROGRESS — Wave 4 of the deferred-stories execution plan ([ADR 0022](../adr/0022-deferred-ai-comms-stories-execution-plan.md)); decision recorded in [ADR 0030](../adr/0030-assistant-inbound-flow-router-turn-runner.md).** Lands **before** Story 5 (Wave 5): the router is what delivers the typed-message-while-a-question-is-pending answer flow that `ask_user` needs. **Behaviour-preserving** — the `AnswerFlow` branch is wired but **inert** until Story 5 (the `PendingInteractionStore` returns "no pending question"); existing command / conflict-confirm / simple-message behaviour is unchanged. Gated by lint + type + jest, human-reviewed (was deferred from the autonomous wave by [ADR 0018](../adr/0018-assistant-ai-comms-phase-b-scope-refinement.md)).

### Story
As a **developer**, I want one **router** that classifies every inbound into exactly one flow and one **convergence point** that runs the loop, so that a fresh message and an answer-to-a-question share all orchestration instead of duplicating it.

### Context / Why now
Story 5 introduces a case the current code never had — a **typed message while an `ask_user` is pending**. We need a single gate that distinguishes it from a fresh message and from an ADR-0006 conflict confirm, and a single `runTurn` that both flows converge on. Design: [assistant-layered-architecture §taxonomy / Flow A/B](assistant-layered-architecture.md#the-inbound-flow-taxonomy-4-flows-one-gate).

### Acceptance Criteria
- [ ] `classifyFlow(normalized, user)` returns exactly one of: `CommandFlow` (no LLM) · `ConflictConfirmFlow` (callback `confirm:` — ADR 0006, **no model**) · `AnswerFlow` (callback `ask:` **or** free-text while a pending question exists) · `SimpleMessageFlow` (else).
- [ ] Given a typed message, when a pending question exists (cheap Redis `EXISTS` on `pendingQuestionKey`), then it routes to `AnswerFlow`; else `SimpleMessageFlow`.
- [ ] Given either a fresh message or an answer, then both seed a `TurnState` and call the **identical** `ToolLoopService.run(state)`, and both reconverge at `ReplyPresenter.present(outcome)` — no flow owns a second copy of "call the model / persist / send".
- [ ] The only divergence is one branch in the router + one line in `TurnRunner` (button→label vs text→raw answer).
- [ ] The `ask:` vs `confirm:` callback prefixes keep the two suspend/resume paths disjoint at the wire level.
- [ ] All existing assistant assertions (esp. the 4 ADR-0006 cases) stay green.

### Out of scope
- The durable store internals (Story 5) — this story only *routes* to it.
- A Haiku "answer vs new request?" gate for in-window non-answers (optional fast-follow).

### Technical notes
- `ingress/inbound-router.ts` (promoted from `webhook.consumer.routeForUser`); `session/turn-runner.service.ts` (the `runTurn` convergence) + `pending-interaction.store.ts` / `conversation.store.ts` / `turn-audit.store.ts`.
- `TurnState` seeded fresh (Flow A) or with the synthetic `ask_user` `tool_result` (Flow B) — the loop is indifferent because it already appends-and-re-enters every round.

### Dependencies / Risks
- Pairs with Story 5 (together they deliver the ask/answer round-trip). Best landed as part of Story 8's lift of `webhook.consumer` / `assistant.service`.
- Risk: regression of the ADR-0006 callback path — the 4 cases are the merge gate.

---

## Story 7 — `check_availability` batch read tool (recurrence-aware)

> **Status: IN PROGRESS — Wave 3 of the deferred-stories execution plan ([ADR 0022](../adr/0022-deferred-ai-comms-stories-execution-plan.md)); decision recorded in [ADR 0029](../adr/0029-assistant-check-availability-batch-read.md).** Depends on Wave 2 (Story 4's registry classification, [ADR 0025](../adr/0025-assistant-buildtool-single-source-registry.md)). Gated by lint + type + jest, human-reviewed (was deferred from the autonomous wave by [ADR 0018](../adr/0018-assistant-ai-comms-phase-b-scope-refinement.md)).

### Story
As a **Cue user**, I want the assistant to **check a whole list of proposed times at once** so that "book these 10 slots" validates and reports conflicts without burning the fetch budget.

### Context / Why now
`find_free_slots` answers "where are the gaps", not "are *these* 10 slots free". The only real conflict primitive (`findOverlapping`) is reachable solely as a write side-effect (the ADR-0006 hold). Validating 10 proposals today = 10 probes — impossible under the 5-fetch cap. Design: [assistant-layered-architecture §lookups](assistant-layered-architecture.md#lookups--proactive-availability--check_availability-recurrence-aware).

### Acceptance Criteria
- [ ] Given `check_availability({ slots: {startAt,endAt,calendarId?,excludeTaskId?}[].min(1).max(25) })`, when dispatched, then it returns per slot `{ index, free, conflicts: {handle,title,occurrenceStart,occurrenceEnd}[] }` with `[eN]` handles on conflicts.
- [ ] It calls `TaskService.findOverlapping` **once per slot with that slot's exact bounds** — the **same** source the write-time hold trusts (a "free" verdict and a later `create_task` never disagree).
- [ ] It **never** reads raw `task` rows / `findInRange` (those miss recurring occupancy) and **never** unions slots into one window (over-reports).
- [ ] It is a **read / schedule-fetch** tool, **never** a write; one batch call = **one** of the five fetches.
- [ ] Given a **recurring proposal** (a slot that is itself a rule), then the tool either rejects it honestly or self-expands the proposed rule and checks each occurrence — it does **not** silently validate one window.

### Out of scope
- Closing the write-side hold gaps — this is the **read-side** mitigation only; the hold stays the authoritative floor (and Story 9 is the write-side fix).
- Replacing the ADR-0006 deterministic hold for single-slot conflicts.

### Technical notes
- Flow it enables: `check_availability([10])` → all free → `create_tasks([free])` → report; some busy → `ask_user` with conflicting handles as options, or let the single-slot hold take over. A "create 10 checking availability" turn becomes **2 rounds, 1 fetch**.
- Authored as `buildTool` (Story 4 registry classifies it read/schedule-fetch).

### Dependencies / Risks
- **Depends on Story 4** (registry classification) and pairs with Story 2 (`create_tasks`) and Story 5 (`ask_user` for the busy branch).
- Risk: the recurring-proposal path is the subtle one — must expand, not single-window.

---

## Story 8 — Layered decomposition of the orchestrator

> **Status: PLANNED — Wave 6 (last) of the deferred-stories execution plan ([ADR 0022](../adr/0022-deferred-ai-comms-stories-execution-plan.md)).** The largest refactor (the god-service lift) goes last, after every story it hosts (1–7) is already proven in the current structure, so it becomes a series of behaviour-preserving lifts rather than a rewrite. Gated by lint + type + jest, human-reviewed (was deferred from the autonomous wave by [ADR 0018](../adr/0018-assistant-ai-comms-phase-b-scope-refinement.md)).

### Story
As a **developer**, I want the assistant split into **one-responsibility layers** (dependencies pointing strictly downward) so that the loop is vendor/Redis/ORM-blind and the answer-flow and message-flow are cleanly separated yet converge.

### Context / Why now
`AssistantService` is a god-service (a 12-arg constructor, ~15 spec cases) that owns ingress, loop, conflict, reply, and background. The new capabilities (re-drive, `ask_user`, batch tools) need a structural home so they land **without special-casing**. This is **not** a big-bang rewrite — it's the vehicle that hosts Stories 1–7 as behaviour-preserving lifts. Design: [assistant-layered-architecture §layer model / migration](assistant-layered-architecture.md#the-layer-model).

### Acceptance Criteria
- [ ] The L0–L11 layer model is realized (ingress · intake · router · turn lifecycle · orchestration loop · tools · context · domain · conflict · reply · AI transport · background+alerts), dependencies strictly downward.
- [ ] The loop (L4) speaks only the `AiConnector` port + a dispatcher interface — it is vendor-blind, Redis-blind, ORM-blind.
- [ ] `ReplyPresenter` (L9) is the **sole** `vendor.send*` caller.
- [ ] The conflict path (L8) is physically isolated and stays deterministic (no model) — the 4 ADR-0006 cases stay green at **every** migration step.
- [ ] Each migration step keeps `AssistantService`'s three public methods + constructor green until the final step **rehomes** (never deletes) the assertions into `turn-runner.service.spec.ts` + per-layer specs.

### Out of scope
- Streaming token UX, MCP, sub-agents, plan mode, compaction stages (CC machinery that doesn't fit an async Telegram backend — keep the ADR-0005 rolling-summary memory model).
- Changing the BullMQ `attempts:1` posture (every terminal path **returns**).

### Technical notes
- 10-step migration (each behaviour-preserving): `redis.constants` key → session stores → `reply/` → `conflict/` → **loop lift (keystone)** → `ai/` withRetry+toolChoice → tool contract+registry → re-drive+alert sink → ask_user+pending store → inbound-router+turn-runner convergence. Module tree + step list in [assistant-layered-architecture §migration plan](assistant-layered-architecture.md#migration-plan-incremental-test-safe).
- Open: whether `AssistantService` is deleted at step 10 or kept as a thin 3-method facade.

### Dependencies / Risks
- Hosts Stories 1–7; can be sequenced so each story *is* a migration step.
- Risk (highest): the loop lift (keystone step) — do it as a **pure byte-identical lift** first, behaviour changes after.

---

## Story 9 — Close the write-side recurring-conflict hold gap

> **Status: IN PROGRESS — Wave 1 of the deferred-stories execution plan ([ADR 0022](../adr/0022-deferred-ai-comms-stories-execution-plan.md)), parallel with Story 3b.** Decision: [ADR 0024](../adr/0024-assistant-recurring-conflict-hold.md) — recurring creates/edits that overlap existing events route through the ADR-0006 hold as **one held write for the whole series** (occurrence-aware via `findClashingRecurringAnchors`, bounded by `MAX_GENERATION_STEPS`); the held action carries the recurrence; far-future/infinite rules are a documented limitation. Per-occurrence holds rejected (don't fit the one-write held mechanism). Still safety-relevant multi-write logic — gated by lint + type + jest and human-reviewed (was deferred from the autonomous wave by [ADR 0018](../adr/0018-assistant-ai-comms-phase-b-scope-refinement.md)).

### Story
As a **Cue user**, I want a **new recurring series to be conflict-checked** like a one-off so that it can't silently book over my existing events.

### Context / Why now
Conflict *detection against existing recurring events* is correct (`findClashingRecurringAnchors`), but the **hold** only runs for non-recurring creates / one-off moves: recurring **creates** (`handleCreateTask` checks `if (!recurrence && startAt && endAt)`) and recurring **edits** (`updateRecurring` has no `findOverlapping`) bypass it entirely. Pre-dates the AI work; flagged for honesty. Detail: [recurrence-expansion §conflict-checking](recurrence-expansion.md#conflict-checking-with-recurrence) · [ai-workflow §9](ai-workflow.md#9-held-conflict-confirmation-adr-0006-layer-4).

### Acceptance Criteria
- [ ] Given a **recurring create** that overlaps existing events, when dispatched, then it routes through the ADR-0006 hold (occurrence-aware via `findClashingRecurringAnchors`) instead of committing silently.
- [ ] Given a **recurring edit** that introduces an overlap, when dispatched, then `updateRecurring` runs the same occurrence-aware conflict check.
- [ ] Given a far-past anchor that would exhaust `MAX_GENERATION_STEPS`, then the behaviour is explicit (documented limitation / safe fallback), not a silent miss.
- [ ] Existing one-off create/move conflict behaviour is unchanged.

### Out of scope
- The read-side pre-flight (`check_availability`, Story 7) — complementary, not a substitute.
- Changing the inline-keyboard confirm UX.

### Technical notes
- Touches `tool-dispatcher.service.ts` (`handleCreateTask` guard at the `!recurrence` branch, `updateRecurring` ~:486) and `TaskService.findClashingRecurringAnchors`. Tracked separately as spawn-task `task_325c8d60`.
- The recurring-proposal expansion logic overlaps with Story 7's correctness contract — share the helper.

### Dependencies / Risks
- Standalone correctness fix; can ship any time, independent of the layered move.
- Risk: expanding a far-future/infinite rule for the check — bound by `MAX_GENERATION_STEPS`; define the fallback.

---

## Milestone v2 — Conversational UX (this enhancement)

**A new application version.** v1 makes the assistant *correct* (it does what it says, it can ask and resume, the code is layered). v2 makes it *feel like a person you're talking to*: an instant living status message, the answer streaming in as it's written, graceful handling of rapid-fire messages, a STOP control, AI judgement over calendar conflicts, tappable bot controls with an ASCII calendar, a daily report, and a per-user personality. All of it is grounded in the **[verified research dossier](ai-workflow-v2-research.md)** (live Telegram docs + cue-api `file:line` recon).

**The single most important verified fact** reshaped the whole UX: Telegram's `sendMessageDraft` (Bot API 9.5+) is a purpose-built streaming primitive — a **30-second ephemeral preview** you update by re-calling with the same `draft_id` (Telegram **animates the transition client-side**), and **must finalize with a real `sendMessage`** to persist. Empty text renders a native "Thinking…" shimmer. This single primitive is *both* the live-status surface (A) and the response-streaming surface (C). It carries **no buttons** (so STOP is a separate message) and is **private-chat only**. A literal 25 ms server animation is infeasible (~40 edits/s → HTTP 429) and unnecessary — the client animates for us.

### Locked decisions (v2)

| Area | Decision | Source |
|---|---|---|
| **Loading animation** | Draft-native. Status **word cycles every 5 s** (localized vocabulary), **trailing dots animate every 500 ms** (`…`→`..`→`.`→`…`) via same-`draft_id` re-calls. Voice → **"Listening to your beautiful voice"** until transcription, then normal loading. | you |
| **Streaming surface** | **Plain `sendMessageDraft`** for v2 (rich `sendRichMessageDraft` is a later opt-in — needs 10.1+ clients). **Gate to private chats**; `editMessageText` (≤1/s) fallback elsewhere. | me |
| **Multi-message** | **Combine** debounce-window messages by concatenation **in order**; the model reconciles corrections vs additions (never silently drops an "and also…"). | you |
| **Active processing** | **Queue-after** (a message mid-turn runs after the current finishes; never cancels it). **STOP keeps committed writes** and replies with a **programmatic** (no AI call) human-readable summary. | you |
| **Conflicts** | **Strict default-deny.** AI double-books only on explicit in-message authorization **or** a user-set durable `conflict_policy` fact (never inferred). Destructive replace requires `ask_user`. **Supersedes [ADR 0006](../adr/0006-assistant-schedule-context-and-conflicts.md) layer 4.** | you |
| **Settings UI** | **iOS app + REST** (no web admin). Telegram stays config-free. | you |

### v2 stories at a glance (suggested order)

| # | Story | Ships | Depends on | New ADR |
|---|---|---|---|---|
| 10 | **Messenger port: draft/edit/keyboard primitives + status session** | the foundation | — | 0012 |
| 11 | **Per-user serialization lock** (shared mutex) | race safety | — | — |
| 12 | **Live status message** — words + dots + voice state | the "Thinking…" UX | 10 | 0012 |
| 13 | **Native response streaming + per-step recaps** | the streamed answer | 10, 12, v1-#3 | 0012 |
| 14 | **Debounce + combine + queue + STOP** | multi-message + cancel | 10, 11 | 0013 |
| 15 | **AI-judged conflicts** (remove the deterministic hold) | conflict judgement | v1-#5 (`ask_user`) | 0011 ⟂ 0006 |
| 16 | **Reply-keyboard controls + ASCII calendar** | bot navigation | 10 | — |
| 17 | **Per-day notification reports** | daily summary | delivery worker | 0015 |
| 18 | **Per-user AI personality** | persona per session | — | 0014 |

> **Sequencing.** Story 10 (messenger primitives) and Story 11 (lock) are the foundation — do them first. Stories 12–13 are the status/streaming core; 14 the message-flow control; 15 the conflict reversal (needs v1's `ask_user`); 16/17/18 are independent feature add-ons. **New ADRs required:** 0011 (AI-judged conflicts, *supersedes* an accepted ADR), 0012 (stateful messenger + ephemeral draft streaming), 0013 (debounce/coalescing/queue/cancel), 0014 (per-user personality + cache placement), 0015 (daily-report scheduler + delivery). They are listed per story; I can draft them next.

---

## Story 10 — Messenger port: draft / edit / keyboard primitives + status session

### Story
As a **developer**, I want the Telegram adapter to be a **stateful** surface that can post a status, edit/stream it, show keyboards, and signal typing — so that every v2 UX feature has a foundation to build on.

### Context / Why now
The messenger port is stateless and minimal today: `ExternalVendorConnector` exposes only `sendMessage`, `sendActions`, `acknowledgeCallback`, `fetchMedia`, `registerWebhook`, `removeWebhook` (`external-vendor-connector.abstract.ts:57-91`); the Telegram connector is raw `fetch` + a private `callApi<T>` (`telegram-vendor.connector.ts:113-136`); **no edit/draft/typing/keyboard methods exist, and no SDK is used**. Dossier: [§A](ai-workflow-v2-research.md#a-stateful-messenger-adapter-status-message--cycling-word--voice-state).

### Acceptance Criteria
- [ ] The port + Telegram connector gain: `editMessageText(target, vendorMessageId, message)`, `sendChatAction(target, action)`, `deleteMessage(target, vendorMessageId)`, `sendMessageDraft(target, draftId, text)`, and a persistent **reply-keyboard** variant — each a thin `callApi('<method>', body)` add (no structural change).
- [ ] Given a private chat, when a turn starts, then a Redis-backed **`StatusSession`** value object `{ chatId, draftId | messageId, phase, locale }` is created and threaded `WebhookConsumer.process() → handleText/handleCallback()` as an optional `statusRef`.
- [ ] `sendMessageDraft` is **gated to `chat.type === 'private'`**; non-private degrades to `editMessageText` (≤1/s) on a real message.
- [ ] `sendMessageDraft` callers must finalize with a real `sendMessage`/`editMessageText` (drafts are 30-second ephemeral previews) — the port documents this contract.
- [ ] Status-message creation is **idempotent** (check Redis for an existing `statusMessageId` before creating) so a future `attempts > 1` can't orphan a second message.

### Out of scope
- The animation loop and vocabulary (Story 12); streaming (Story 13); the reply-keyboard *routing* (Story 16) — this story only adds the *primitives*.
- Adopting grammY/Telegraf — the raw `callApi` approach is retained.

### Technical notes
- `StatusSession` is **Redis-backed, not a DB entity** (ephemeral per-turn). Key e.g. `assistant:status:{correlationId}`.
- The draft `draft_id` must be a stable non-zero integer per turn (derive from the correlationId/job).
- Reply keyboard body: `reply_markup: { keyboard, is_persistent: true, resize_keyboard: true }`.

### Dependencies / Risks
- Foundation for Stories 12, 13, 16. Independent of v1 (can start immediately).
- Risk: draft-update throttle is **undocumented** ([dossier open risk](ai-workflow-v2-research.md#open-risks--unknowns)) — cap all draft calls at ~2–5/s centrally in the connector.
- ADR 0012 records the stateful-messenger + ephemeral-draft contract.

---

## Story 11 — Per-user serialization lock (shared mutex)

### Story
As a **developer**, I want one **per-user lock** so that two inbound updates for the same user can't process concurrently and corrupt each other.

### Context / Why now
Two hazards share one root: a message arriving during active processing (Story 14 "queue-after") and two answers racing an `ask_user` resume ([ADR 0010](../adr/0010-assistant-ask-user-stateful-resume.md) notes "a per-user advisory lock would close the window fully"). Build the lock **once**. Dossier: [§cross-cutting #4](ai-workflow-v2-research.md#cross-cutting-dependencies--sequencing).

### Acceptance Criteria
- [ ] A per-user Redis mutex (`assistant:lock:{userId}`, short TTL + renewal) is acquired around a turn and released in a `finally`.
- [ ] The lock **auto-expires** so a crashed worker never deadlocks a user.
- [ ] Given the lock is held, when a new inbound for that user arrives, then it is enqueued to run after (Story 14), not dropped and not run concurrently.
- [ ] `ask_user` resume (v1 Story 5) acquires the same lock, closing the double-resume race the compare-and-set only partially covers.

### Out of scope
- The queue-after behaviour itself (Story 14) and the debounce window (Story 14) — this is just the primitive.

### Technical notes
- A renew-able Redis lock (`SET key val NX PX ttl` + a watchdog renew, or a small `redlock`-style helper consistent with the repo's no-new-deps lean). Released by token to avoid releasing someone else's lock.

### Dependencies / Risks
- Foundation; consumed by Stories 14 and v1 Story 5. Independent.
- Risk: lock TTL vs a long turn — renew while processing; never let it lapse mid-turn.

---

## Story 12 — Live status message (loading words + dots animation + voice state)

### Story
As a **Cue user**, I want an instant, lively status the moment I send something — a cycling "Thinking… / Cooking… / Brewing…" with animated dots — so that I know the bot heard me and is working.

### Context / Why now
Today nothing is shown until the full reply is ready. With the messenger now stateful (Story 10), we post an immediate draft and animate it. Verified: same-`draft_id` re-calls animate client-side; empty text shows a native "Thinking…". Dossier: [§A](ai-workflow-v2-research.md#a-stateful-messenger-adapter-status-message--cycling-word--voice-state).

### Acceptance Criteria
- [ ] Given an inbound message in a private chat, when the job starts, then a `sendMessageDraft` (empty text → native "Thinking…") is posted within ~1 s, before any heavy work.
- [ ] The status **word changes every 5 seconds**, drawn from the locale vocabulary ([Appendix](#appendix-a--loading-vocabulary)), selected by Telegram `language_code` (`uk` / `ru` / else `en`), with no immediate repeat.
- [ ] The **trailing dots animate every 500 ms**, cycling `…` (3) → `..` (2) → `.` (1) → back to `…`, via same-`draft_id` re-calls (Telegram animates the transition).
- [ ] Combined draft-update rate stays **≤ ~2–5 calls/sec**; the draft is refreshed within its **30 s TTL** so it never expires mid-turn (the dot loop doubles as keepalive).
- [ ] Given a **voice** message, the status reads **"Listening to your beautiful voice"** (localized, same dot animation) from before `connector.fetchMedia()` until `stt.transcribe()` returns (`webhook.consumer.ts:~96`), then switches to the normal loading vocabulary.
- [ ] The animation `setInterval` is **cleared in a `finally`** in `WebhookConsumer.process()` (no timer leak if the job ends/throws).
- [ ] Non-private chats degrade to a single static status line (no animation).

### Out of scope
- Streaming the actual answer (Story 13); per-step recaps (Story 13); the "Waiting for you to finish…" debounce status (Story 14).

### Technical notes
- The 30 phrases per language live in a constant (e.g. `assistant/status-phrases.ts`: `LOADING_PHRASES[locale]`, `VOICE_LISTENING_PHRASE[locale]`) — see [Appendix A](#appendix-a--loading-vocabulary).
- One animation driver advances internal state on a 500 ms tick (dots) with a 5 s word-swap counter, and flushes to `sendMessageDraft` — the *internal* tick is 500 ms, never 25 ms.

### Dependencies / Risks
- **Depends on Story 10.** ADR 0012.
- Risk: throttle (undocumented) — keep ≤5/s; the 2/s dot cadence is safe.

---

## Story 13 — Native response streaming + per-step recaps

### Story
As a **Cue user**, I want the reply to **stream in as it's written**, and to see a one-line "what I'm doing now" when the bot looks things up — so it feels alive, not frozen.

### Context / Why now
The connector is fully non-streaming today (`complete(): Promise<CompletionResult>`), **but the installed `@anthropic-ai/sdk@0.100.1` already exposes `client.messages.stream()`** — no upgrade needed (`MessageStream.d.ts:9,108`). The per-step recap insertion point is exact: `assistant.service.ts:447-458`, between rounds, where `steps[]` already carries `{ name, input, resultContent, isError }`. Dossier: [§C](ai-workflow-v2-research.md#c-native-streaming-drafts--per-step-recap-in-the-status-message).

### Acceptance Criteria
- [ ] A `completeStream(request, onText)` is added to the AI port, implemented via `client.messages.stream()` + `finalMessage()` normalized through the existing `toCompletionResult()` (the `CompletionResult` shape is unchanged); a `streaming: boolean` joins `AiCapabilities`.
- [ ] Given a private chat, when the **final (`end_turn`) round** produces text, then it streams via **throttled `sendMessageDraft` (≤5 updates/s)** into the turn's draft, and is **finalized with a real `sendMessage`** that persists `vendorMessageId` (as today, `conversation-message.entity.ts:71-77`).
- [ ] Given the model runs a tool round (a lookup/write), when the round completes, then a **1-sentence recap** generated from `steps[]` by the **BACKGROUND (Haiku) model** is written into the **status draft** between rounds — leaving the main reply untouched.
- [ ] Streaming is **gated to private chats**; non-private falls back to the non-streamed reply.
- [ ] Plain `sendMessageDraft` only (no `sendRichMessageDraft` in v2).
- [ ] **`completeStream` MUST return, never throw — and reconcile a partial draft ([ai-comms audit §B](ai-comms-cc-audit.md)).** Under `attempts:1` a throw out of the turn runner loses the turn, so `completeStream` wraps stream consumption in its own try/catch: an error **before** any draft text → **one** non-streamed `complete()` fallback; an error **after** partial draft text → finalize the partial as the reply (or fall back) — **always** return a `CompletionResult` / degrade gracefully. The draft-finalize `sendMessage` is itself guarded so a finalize error can't orphan the turn. Ports only CC's *fallback-on-empty-stream* principle (not its 90s watchdog / 64k cap).

### Out of scope
- Rich/formatted streaming (`sendRichMessageDraft`) — later opt-in.
- Reusing the main model for recaps (rejected — changes the final-reply UX; Haiku is cheaper and keeps the answer intact).

### Technical notes
- ✅ **Streaming-risk RESOLVED (ai-comms audit verification):** `client.beta.messages.stream()` **exists** in the installed SDK 0.100.1 (`node_modules/@anthropic-ai/sdk/resources/beta/messages/messages.d.ts:58` → `BetaMessageStream`, `finalMessage()` at `lib/BetaMessageStream.d.ts:109`). The contingency ("stream only on non-context-edited turns") is **dropped** — implement `completeStream` over `client.beta.messages.stream({ ..., betas:[CONTEXT_MANAGEMENT_BETA], context_management:{...} })`, mirroring `createMessage`'s stable/beta two-branch shape so the beta header + `context_management` ride along on the streamed call.
- Recap cost ≈ Haiku `completeStructured` ~$0.00025 each (~$0.0012 for a 5-round turn).

### Dependencies / Risks
- **Depends on Stories 10, 12** and v1 Story 3 (the connector already touched for `AiToolChoice`). ADR 0012.
- Risk: draft throttle (undocumented) — batch deltas to ~2–5/s, not per-token.

---

## Story 14 — Message debounce + combine-coalescing + queue-after + STOP

### Story
As a **Cue user**, I want to fire off several quick messages and have the bot wait, combine them, and act once — and a **STOP** button to bail out — so rapid-fire chatting doesn't create conflicting half-done turns.

### Context / Why now
Each inbound is one BullMQ job today; there is **no debounce, coalescing, queue, or cancellation** (`assistant-webhook.controller.ts:108-116`, `webhook.consumer.ts:67-79`), and `runToolLoop` has **no interrupt point**. Telegram gives **no inbound typing/recording signal**, so "wait while the user types" is approximated by re-arming on rapid follow-ups. Dossier: [§B](ai-workflow-v2-research.md#b-debounce--coalescing--queueing--cancellation-stop).

### Acceptance Criteria
- [ ] Given an inbound message, when it arrives, then a **per-user debounce window** (~2 s from the message timestamp, Redis `assistant:debounce:{userId}`, BullMQ `delay`) opens; the status shows **"Waiting for you to finish…"** (localized).
- [ ] Given more messages arrive **within the window**, then they are **combined by concatenation in arrival order** into one turn (the model reconciles corrections vs additions); the prior timer is **dropped and re-armed** — never two turns.
- [ ] Given a message arrives while a turn is **actively processing**, then it is **enqueued to run after** the current turn (per-user lock, Story 11) — it **does not cancel** the active turn.
- [ ] A **STOP** inline button (a *separate real message* via `sendActions`, callback prefix `stop:`) sets a Redis flag the loop checks **between rounds and after each write**; on STOP the loop exits.
- [ ] On STOP, **committed writes are kept** (no rollback — consistent with `attempts: 1`) and the user gets a **programmatically built** (no AI call) human-readable summary of exactly those writes (e.g. *"Created 'Dentist' Tue 14:00; moved 'Standup' → 09:00"*), from the existing `rounds[].steps` ledger (`assistant.service.ts:376-458`).

### Out of scope
- Detecting real typing/recording (Telegram doesn't deliver it — documented limitation; approximated by re-arm).
- Rollback / Undo on STOP (you chose keep-and-summarize; a real Undo can be a later feature).

### Technical notes
- Cancellation = a cooperative checkpoint: the loop reads `assistant:stop:{correlationId}` between rounds and after each write, then exits early (no AbortController plumbing required).
- The STOP message is distinct from the draft status (drafts carry no buttons) and uses a new callback prefix, disjoint from `confirm:`/`cancel:`/`ask:`.
- "Combine" preserves order so the model can treat a later message as superseding an earlier one.

### Dependencies / Risks
- **Depends on Stories 10 (messenger), 11 (lock).** ADR 0013.
- Risk: queue-during-active racing the first turn's writes — the per-user lock serializes; without it, double-processing is possible.

---

## Story 15 — AI-judged conflicts (remove the deterministic hold)

### Story
As a **Cue user**, I want the assistant to **use judgement** about calendar clashes — proceed when I've said overlaps are fine, otherwise ask me — instead of a rigid "Book anyway?/Cancel" popup every time.

### Context / Why now
The ADR-0006 hold is deterministic and never re-invokes the model (`tool-dispatcher.service.ts:376-393`, `:608-626`; `assistant.service.ts:566-877`). v2 hands the call to the AI, with a **strict default-deny** safety posture. This **supersedes ADR-0006 layer 4** and reuses v1's `ask_user`. Dossier: [§D](ai-workflow-v2-research.md#d-ai-judged-conflicts-replacing-the-adr-0006-deterministic-hold).

### Acceptance Criteria
- [ ] The deterministic hold is **removed**: `holdAndAsk`, `executeHeldBatch`, `buildHeldPrompt`, the `kind:'held'` branch, the `confirm:`/`cancel:` callback handling, `HeldConflictBatch`/`ConflictCallbackAction` types, `ASSISTANT_HELD_CONFLICT_TTL_SECONDS` + the `heldConflictKey` constant — all deleted. **`TaskService.findOverlapping` is KEPT** (it now describes conflicts to the model).
- [ ] Given a write overlaps, when dispatched, then the dispatcher returns a **recoverable `isError` tool result** describing it (*"Conflict: overlaps 'X' (start–end). Default: do NOT proceed unless the user explicitly accepted."*) — the model decides.
- [ ] The model proceeds over a conflict **only** when (a) the user authorizes **in-message**, or (b) a durable, **explicit** `conflict_policy` `UserMemoryFact` (user-set, **never inferred** by the extractor) allows it; otherwise it calls **`ask_user`** (v1 Story 5).
- [ ] Any **destructive replace** (delete an existing event to make room) requires an explicit `ask_user` first.
- [ ] The system prompt states the **default-deny** rule firmly; the dispatcher restates it in **every** conflict tool-result.
- [ ] The 5 held-specific spec cases (`assistant.service.spec.ts`) + 2 in `tool-dispatcher.service.spec.ts` are replaced with AI-judged-conflict cases.

### Out of scope
- Recurring-series conflicts remain deferred (an expanded series clashing on many dates doesn't fit one ask) — see v1 Story 9.
- Inferring acceptability from soft context (you chose strict + explicit-only).

### Technical notes
- `conflict_policy` is a `UserMemoryFact` (`type='preference'`, explicit source) rendered in the profile block (`context-builder.service.ts:78-94`).
- **ADR 0011 supersedes [ADR 0006](../adr/0006-assistant-schedule-context-and-conflicts.md) layer 4** — write it (immutable-supersede convention).
- Clean up the now-dead held config/keys to avoid drift.

### Dependencies / Risks
- **Depends on v1 Story 5 (`ask_user`).** ADR 0011 (⟂ 0006).
- Risk (safety): a deterministic gate becomes model judgement — a prompt regression could silently double-book. Default-deny in both the prompt **and** every tool-result is the mitigation; the durable flag is user-set only.

---

## Story 16 — Reply-keyboard controls + ASCII calendar + latest-button-as-context

### Story
As a **Cue user**, I want tappable bot controls — **Today's schedule**, **Next week**, **Settings** — and a clean text calendar, so I can drive Cue without typing, and the bot remembers what I just looked at.

### Context / Why now
The connector has no reply-keyboard support (`sendActions` builds inline only, `telegram-vendor.connector.ts:355-368`). Reply-keyboard taps arrive as **plain text equal to the label** (not `callback_query`), and a keyboard is swapped by sending a **new** message. Dossier: [§E](ai-workflow-v2-research.md#e-persistent-reply-keyboard--ascii-calendar--latest-button-result-context).

### Acceptance Criteria
- [ ] A **persistent reply keyboard** (`is_persistent: true`, `resize_keyboard: true`) shows **[Today's schedule] [Next week] [Settings]**; tapping **Settings** sends a new message swapping to **[Disconnect] [Back]**; **Back** restores the main keyboard.
- [ ] Taps are routed by **text-equality on the label**, and only treated as a command **when the reply keyboard is the active surface** (so a task titled "Today" isn't hijacked).
- [ ] **Today / Next week** render an **ASCII/TUI monospace calendar** (inside a ``` code block) built from `TaskService.findOccurrencesInRange`, kept to **≤ ~30 chars/line** for mobile.
- [ ] The **latest** button result (only the latest of multiple clicks) is stored in Redis `assistant:lastButton:{userId}` (**overwrite**, not append) and injected into the **next turn's volatile messages tail** (never the cached prefix — ADR 0004).
- [ ] **Disconnect** triggers the existing unlink flow.

### Out of scope
- Inline-button in-turn decisions (conflict confirm / `ask_user`) stay separate — reply keyboard is *navigation chrome* only.
- A graphical calendar image (ASCII only).

### Technical notes
- The calendar renderer is a **pure function** (no Telegram dependency) producing a monospace month/week grid — unit-testable.
- New connector method or a `reply_markup` variant on `sendMessage`/`sendActions`.

### Dependencies / Risks
- **Depends on Story 10** (reply-keyboard primitive). No new ADR (small).
- Risk: label/title collision — gate command-interpretation on "reply keyboard is the active surface".

---

## Story 17 — Per-day notification reports

### Story
As a **Cue user**, I want a **daily summary** of my day at a time I choose, in my own words (a custom prompt), so I start each day oriented — configured from the app, not Telegram.

### Context / Why now
`@nestjs/schedule` is installed but **unused**; BullMQ is the live scheduler; **no delivery worker exists** (`ScheduledNotification` is a schema-only outbox); `User.timezone` (IANA) exists; there is **no web UI** and **no `UserPreferences` entity**. Dossier: [§F](ai-workflow-v2-research.md#f-per-day-notification-reports-scheduler--ai-summary--delivery-configured-via-management-ui).

### Acceptance Criteria
- [ ] **Prerequisite:** a `ScheduledNotification` **delivery worker** (or direct Telegram send) exists (this blocks the feature — flag if not yet built).
- [ ] A new `UserReportSettings` entity (`reportEnabled`, `reportTimeLocal`, `reportChannel`, `reportPromptOverride` nullable) + migration (hand-written SQL, `{unixMs}-…` order).
- [ ] REST `GET`/`PATCH /users/me/report-settings` behind `AccessTokenGuard`; `docs/api/openapi.yaml` updated in the same PR (the iOS app owns the screen).
- [ ] A `@nestjs/schedule` **per-minute** job scans opted-in users whose `User.timezone` local time matches `reportTimeLocal` (luxon), **idempotent** via a per-user "last sent date" guard (no double-send across deploy restarts), and enqueues a BullMQ build-and-send job.
- [ ] The job builds the day's report, makes **one AI request → one response** (default prompt, overridable per-user; **no tool loop**), and delivers via the Telegram connector.
- [ ] Telegram exposes **no** configuration for this feature.

### Out of scope
- The iOS settings screen itself (cue-ios owns it; this story ships the REST + entity + scheduler).
- A web admin (you chose iOS-only).

### Technical notes
- New env vars (cron expression / lookahead) added to the Zod schema **and** `infra/production/ssm.tf` **and** `.env.example` together.
- Reuse the BACKGROUND (Haiku) or main model for the one-shot summary — engineer's call; Haiku is cheaper for a summary.

### Dependencies / Risks
- **Blocked by the delivery worker** (the larger prerequisite). ADR 0015.
- Risk: per-user-timezone cron — the per-minute global scan is simplest/cheap at current scale; revisit per-user repeatable jobs only if needed.

---

## Story 18 — Per-user AI personality

### Story
As a **Cue user**, I want to give the assistant a **personality** (or pick a preset like Jarvis) that colours every conversation, so it talks the way I like.

### Context / Why now
The persona is a single shared compile-time constant today (`ASSISTANT_SYSTEM_PROMPT`, `assistant.prompts.ts:13-40`) injected as **system block 1 with `cacheBoundary: true`** — byte-identical for all users. A per-user persona must sit **below cache breakpoint #1** (in the per-user region closed by breakpoint #2) or it destroys the cross-user shared cache. Dossier: [§G](ai-workflow-v2-research.md#g-per-user-ai-personality-persona-string-per-session-default--seeded-jarvis-adr-0004-caching-consequence).

### Acceptance Criteria
- [ ] A new `PersonaPrompt` entity (`userId` FK, `promptText`, `source` enum, `updatedAt`) + repo + DatabaseService + migration; a **seeded "Jarvis" preset** row.
- [ ] REST `GET`/`PATCH /users/me/persona-settings` (pick a preset **or** write custom text) behind `AccessTokenGuard`; `openapi.yaml` updated.
- [ ] The active per-user persona is injected as a `PromptBlock` **between the profile/groups blocks and the rolling summary, with NO `cacheBoundary`** — inside the per-user region closed by breakpoint #2; **block 1 (shared system prompt + tool defs) is untouched**.
- [ ] Default = the existing Jarvis text when no persona is set; the persona attaches to **every AI session (turn)** for that user.
- [ ] **The cache-bug AC is DROPPED — replaced by a comment-correction note** ([ADR 0016 A4](../adr/0016-assistant-ai-comms-audit-hardening.md) · [audit §A4/§B](ai-comms-cc-audit.md)). The earlier "tool defs billed at full price every turn" premise was a **misdiagnosis**: the stale comment at `tool-schemas.ts:236-240` claims the last schema "carries `cacheBoundary`", but **no `ToolSchema` sets it** (grep count = 0) — and it **doesn't need to**. Tools are **already cached by breakpoint #1** because the `tools` block precedes `system` in Anthropic's prefix order (`context-builder.service.ts:275`). Fix or delete the false comment + the dead `ToolSchema.cacheBoundary` path (`ai.types.ts:74`, `connector.ts:253`); **do not** wire a redundant tools breakpoint. (Optional: add `cache_read` observability to verify the already-cached behaviour — this part is A4, not Story 18.)

### Out of scope
- Managing/curating the preset library (you said: one seeded Jarvis row is enough for now).
- Moving persona into block 1 (would nuke the shared cache — explicitly forbidden).

### Technical notes
- `PersonaPrompt` follows the strict entity → repository → DatabaseService → migration order.
- Insert the block in `ContextBuilderService.build()` between profile/groups (`context-builder.service.ts:259-285`) and the summary block — no new breakpoint.

### Dependencies / Risks
- Independent (touches context-builder + a new entity). ADR 0014.
- Risk: a naive insert into block 1 regresses the cross-user cache — the AC pins it below breakpoint #1.

---

## Appendix A — Loading vocabulary

For Story 12. Single evocative words (the animating dots are appended: `Готую…`). Selected by Telegram `language_code` (`uk` / `ru` / else `en`); cycle every 5 s, no immediate repeat. Suggested home: `assistant/status-phrases.ts`.

**Voice state** (shown while transcribing, before normal loading):
- `en`: **Listening to your beautiful voice**
- `uk`: **Слухаю ваш чудовий голос**
- `ru`: **Слушаю ваш прекрасный голос**

**English (30):** Thinking · Cooking · Brewing · Plotting · Pondering · Conjuring · Scheming · Crunching · Dreaming · Weaving · Calculating · Summoning · Orchestrating · Composing · Untangling · Aligning · Sketching · Percolating · Mulling · Noodling · Assembling · Wrangling · Charting · Distilling · Forging · Marinating · Daydreaming · Tinkering · Synthesizing · Manifesting

**Українська (30):** Думаю · Готую · Заварюю · Планую · Міркую · Чаклую · Рахую · Мрію · Плету · Складаю · Креслю · Майструю · Зважую · Вигадую · Кумекаю · Метикую · Збираю · Налаштовую · Компоную · Розплутую · Шукаю · Прикидаю · Обмірковую · Ворожу · Фантазую · Мудрую · Накидаю · Узгоджую · Творю · Готуюся

**Русский (30):** Думаю · Готовлю · Завариваю · Планирую · Кумекаю · Колдую · Считаю · Мечтаю · Плету · Собираю · Черчу · Мастерю · Взвешиваю · Придумываю · Соображаю · Прикидываю · Размышляю · Настраиваю · Компоную · Распутываю · Ищу · Ворожу · Фантазирую · Мудрю · Набрасываю · Согласую · Творю · Стряпаю · Замышляю · Химичу

---

> **Definition of Ready & Definition of Done: see team wiki.** Each story above is sized to be independently Ready; the deep design and decision records are linked per story.
</content>
