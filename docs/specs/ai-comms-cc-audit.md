# AI Communication Audit — reconciled accepted findings (cue-api ⟂ claude-code)

**Status:** Accepted — 2026-06-20 · **Audience:** lead engineer (@danil) · **Date:** 2026-06-20

## Preamble

This document is the **single reconciled, authoritative** record of the AI-communication audit of cue-api's assistant — an **async Telegram backend** (webhook → BullMQ `attempts:1` → tool loop → reply), not an interactive CLI. It merges **two independent audits**:

1. The multi-agent team's audit (the prior version of this file), and
2. The lead engineer's independent findings (L1–L4 below), **all accepted**.

Where the two overlap they have been **deduped into one item** (most notably: the team's "handle `MAX_TOKENS` distinctly" finding and the lead engineer's L1 "content-scan continue-signal" both concern the loop's **terminal stop-reason handling** — they are merged into a single terminal-handling item, A1). Every retained claim was verified against the live code and specs; the team's verified `file:line` citations are preserved.

The plan was already strongly claude-code-aware, and that calibration is correct for this backend. It adopts the CC mechanics that fit (single-source tools, 529 → fallback, narration re-drive, SDK streaming) and **correctly rejects** the CLI-shaped machinery that does not (ToolSearch/`defer_loading`, MCP, sub-agent orchestration, parallel tool dispatch, plan mode, CC's manual stream reassembly). None of those rejections are revisited here.

The findings are split into **two explicit lists**:

- **(A) CODE-NOW** — small, correctness-bearing fixes implemented now (Phase A; sequencing in [ADR 0017](../adr/0017-assistant-ai-comms-implementation-scope.md), decisions in [ADR 0016](../adr/0016-assistant-ai-comms-audit-hardening.md)).
- **(B) PLAN-HARDENING** — corrections recorded against the larger v1/v2 stories, **not coded now**; they fix the spec while the relevant story is still Draft.

### Lead-engineer findings (L1–L4, all accepted)

- **L1 — Content-scan continue-signal.** `assistant.service.ts` gated loop-continuation on `stopReason !== TOOL_USE`. That gate must go — **continue iff `toolCalls.length > 0`**, so a `max_tokens` turn that still carries `tool_use` blocks is dispatched rather than dropped. *(Merged with the team's "MAX_TOKENS" terminal finding → A1.)*
- **L2 — Zod `.describe()` port.** The Zod validators in `tools/tool-schemas.ts` had **no `.describe()`**; port the hand-JSON field descriptions onto them so a future `buildTool` + `z.toJSONSchema()` preserves model steering. *(→ A2.)*
- **L3 — Cache misdiagnosis.** The "tools billed full-price every turn" claim (v2 §G / Story 18) is **WRONG** — tools precede `system` in the Anthropic prefix and are **already cached by breakpoint #1** on the persona system block (`context-builder.service.ts:275`; the builder's own comment is correct). Fix = correct the **stale comment** at `tool-schemas.ts:236-240` + add `cache_read` observability; **do NOT** add a tool `cacheBoundary`; **DROP** Story 18's cache-bug AC. *(→ A4, and B/Story 18.)*
- **L4 — Silent-drop.** `contextBuilder.build()` ran **outside** `runToolLoop`'s try (`assistant.service.ts:315` vs `:334`) and `handleText` has no outer guard, so a context-build throw → the user gets **silence** (the consumer just releases dedupe + rethrows; `attempts:1`, no redelivery). Wrap so every inbound yields `AI_FAILURE_REPLY`. Fix the stale "BullMQ retries" comment in `webhook.consumer.ts`. *(→ A5.)*

---

## (A) CODE-NOW — implemented now (Phase A)

Five surgical fixes. Each is a single, tightly-scoped change rather than its own architectural decision; recorded together in [ADR 0016](../adr/0016-assistant-ai-comms-audit-hardening.md), sequenced as Phase A in [ADR 0017](../adr/0017-assistant-ai-comms-implementation-scope.md).

### A1 — Terminal-handling overhaul *(merges L1 + the team's `MAX_TOKENS` finding)*

**Two coupled changes to `runToolLoop`'s loop-and-terminal logic (`assistant.service.ts:350-363`):**

1. **Continue-signal = content scan (L1).** Drop the `stopReason !== TOOL_USE` gate. The loop continues **iff the turn emitted tool calls** (`toolCalls.length > 0`), so a turn that carries `tool_use` blocks under a stop reason other than `TOOL_USE` (e.g. `MAX_TOKENS`, when the model is cut off mid tool-call burst) is **still dispatched** rather than having its calls dropped on the floor and a truncated reply returned. The connector already maps `max_tokens → AiStopReason.MAX_TOKENS` and `refusal → AiStopReason.REFUSAL` (`anthropic-ai.connector.ts:265-282`); the loop simply never read them.

2. **Honest terminal branch on a no-tool-call turn.** When the turn carries **no** tool calls (true terminal), branch on `stopReason` **before** the generic return — splitting today's overloaded `result.text ?? ROUNDTRIP_CEILING_REPLY` (`:357`), which currently collapses every non-`TOOL_USE` reason into one return:
   - **`MAX_TOKENS`** → an honest **"had to cut that short"** reply constant. **NOT** the truncated fragment relayed verbatim (which would deliver a confident half-answer — e.g. a created-task confirmation truncated halfway), and **NOT** the misleading `ROUNDTRIP_CEILING_REPLY` "too many steps" text.
   - **`REFUSAL`** → a dedicated honest **decline** reply constant (no retry). *(A `REFUSAL` turn currently resolves to the misleading `ROUNDTRIP_CEILING_REPLY` via `:357`.)*
   - **else** (`END_TURN` / `STOP_SEQUENCE` / `OTHER`) → return `result.text` as today. Reserve `ROUNDTRIP_CEILING_REPLY` for the genuine round-trip-ceiling return at `:475`.

- **Phase-B refinement (deliberately deferred, not coded now):** a **bounded `max_tokens` bump-retry** (one capped re-issue of the same round at a raised `maxTokens`, reusing the existing `CompletionRequest.maxTokens` passthrough at `ai.types.ts:143` → `connector.ts:394`) before falling back to the honest "cut short" constant. Deferred **for safety** — on a queue where each call costs a whole turn, the honest reply is the safe floor; the bump-retry is an optional polish, not part of CODE-NOW. *(Scoped down from CC's 8k→64k + 3-continuation machinery, report §4c.)*
- **Benefit:** stops the bot confidently delivering half-answers or telling a refused user "too many steps"; a content-carrying truncated turn still dispatches its writes.
- **Confidence:** high.

### A2 — Zod `.describe()` port *(L2)*

- Port the hand-written JSON field descriptions onto **every field** of the Zod validators in `tools/tool-schemas.ts` (which carried **no `.describe()`**), so that when Story 4's `buildTool` derives the model-facing JSON via `z.toJSONSchema()`, the **model-steering descriptions survive the derivation**. Without this, descriptions that today live only in the hand-written JSON block are silently dropped on migration, weakening the model-facing contract.
- A PR check backstops it: the derived model-facing JSON must be **at least as descriptive** as today's hand-written block.
- **Confidence:** high.

### A3 — Cap `list_tasks` / `list_groups` result size

- **Now:** `list_tasks` renders one line per occurrence via `lines.join('\n')` with **no cap** (`tool-dispatcher.service.ts:246`); `list_groups` joins **all** names (`:772`). Only `find_free_slots` is bounded (`MAX_FREE_SLOTS = 5`, `:30`/`:293`). The two list tools are the inconsistent gap.
- **Change:** add `MAX_LIST_LINES` (e.g. 40) beside `MAX_FREE_SLOTS`; in the `list_tasks` handler slice `lines` and append a `"(+N more — narrow the range or filter by group)"` tail when truncated; cap `list_groups` similarly — **mirroring `find_free_slots`' `MAX_FREE_SLOTS`** bounding. Adopt CC's *intent* (bounded results); **reject** CC's disk-persistence / `<persisted-output>` machinery — there is no replay/transcript store here for it to land in.
- **Benefit:** `list_tasks` output lands in the volatile post-breakpoint-#2 region, so an unbounded dump is paid at full input price every turn it appears **and** bloats the next rolling summary (ADR-0005). The tail also steers the model to narrow rather than silently working off a partial list it thinks is complete.
- **Confidence:** high.

### A4 — Cache-comment fix + `cache_read`/`creation` observability *(L3)*

- **Verified:** **No** `ASSISTANT_TOOL_SCHEMAS` entry sets `cacheBoundary` (grep count = 0), yet the stale comment at `tool-schemas.ts:236-240` claims the last schema "carries `cacheBoundary`". Meanwhile breakpoint #1 already sits on system block 1 (`context-builder.service.ts:275`), and Anthropic's prefix order (`tools → system → messages`) means the tool defs are **already swept into that cached prefix** — the builder's own comment there is **correct**. So the user-visible cost today is **~zero**; the "tools billed full-price every turn" framing (v2 §G / Story 18) is a **misdiagnosis**.
- **Change:** (1) correct the stale/false comment at `tool-schemas.ts:236-240` and the dead `ToolSchema.cacheBoundary` path (`ai.types.ts:74`; `connector.ts:253`); (2) add **`cache_read` / `cache_creation` observability** logging so the already-cached behaviour is **verifiable** rather than assumed. **Do NOT** wire a redundant tools-tail cache breakpoint (the API caps at 4; system already uses 2 at `:275`/`:284`). **DROP** Story 18's cache-bug AC (replace it with the comment-correction note — see (B)).
- **Confidence:** high.

### A5 — Graceful-failure net over context-building + webhook comment fix *(L4)*

- **Verified:** `contextBuilder.build()` ran **outside** `runToolLoop`'s try (`assistant.service.ts:315` vs `:334`), and `handleText` has no outer guard. A throw while assembling prompt blocks (rolling summary or agenda read) therefore escaped `runToolLoop` → the consumer released its dedupe guard and **rethrew** → under `attempts:1` (no redelivery) the user got **silence**: `attemptsMade:1`, no reply persisted, no AI_FAILURE_REPLY.
- **Change:** move context assembly **inside** the try so a build failure yields `kind:'error' → AI_FAILURE_REPLY` like any other terminal failure — **every inbound message yields a reply**. Log the assembly failure **loudly** so the degraded path can't mask a real bug. Fix the **stale "BullMQ retries" comment** in `webhook.consumer.ts` (the failure-handling premise is `attempts:1` / no redelivery — the comment must not claim the queue replays a thrown turn).
- **Confidence:** high.

---

## (B) PLAN-HARDENING — recorded against the stories, not coded now

Corrections to *planned* CC-adoptions that are wrong, risky, or under-specified — best fixed in the spec while the story is still Draft. These are **not** Phase A work; they harden the v1/v2 backlog.

### Story 3 — 529 → fallback-model swap is the **top failure-handling story for Phase B**

- **Verified:** the SDK's `maxRetries` retries the **same** overloaded model on a 529; `describeAnthropicError` (`anthropic-ai.connector.ts:430-451`) classifies retryability for *logging only* and has no 529 branch; `complete()` rethrows raw (`:502`). Under `attempts:1` with no replay, a sustained main-model overload = a dead turn with no attempt on a fallback.
- **Hardening:** confirm **Story 3's 529-detection + fallback-model swap** as the **single highest-value failure-handling item** for Phase B — a layer **above** the SDK retries, degrading to today's terminal-error reply if the fallback also fails. Centralize 529 detection in **one exported `is529()` helper** (`status === 529` **OR** the body substring `"type":"overloaded_error"` — the SDK can drop the status mid-stream), consumed by **both** the fallback decision and `describeAnthropicError`, with a focused unit spec (status-529, status-dropped body-string, neither). Keep the SDK transport tier; add only the fallback it lacks. This is already Story 3 — recorded here as the **priority**, not a new idea.

### Story 13 — `completeStream` MUST return-never-throw and reconcile a partial draft under `attempts:1`

- **Verified:** the tool loop **never throws** — it returns `{ kind:'error' }` from the outer catch (`assistant.service.ts:480-493`) because BullMQ is `attempts:1` and a throw loses the turn. Story 13 / [ADR 0012](../adr/0012-assistant-stateful-messenger-and-draft-streaming.md) are **silent** on what happens if the stream errors mid-way, or if the draft-finalize `sendMessage` fails *after* partial text was already shown.
- **Hardening (add as a Story 13 AC):** `completeStream` wraps stream consumption in its own try/catch. Error **before** any draft text → one non-streamed `complete()` fallback. Error **after** partial draft text → finalize the partial as the reply (or fall back). **Always** return a `CompletionResult` / degrade gracefully — **never throw out of the turn runner**. Guard the draft-finalize `sendMessage` so a finalize error can't orphan the turn. Port only CC's *fallback-on-empty-stream principle*, not its 90s watchdog / 64k cap. *(CC can afford to throw-and-retry because it is interactive; cue is a no-retry queue worker.)*

### Story 4 — add the `.describe()` AC

- Story 4 (`buildTool` + `z.toJSONSchema()` single-source registry) must carry the **A2 `.describe()` requirement as an explicit acceptance criterion**: every Zod field carries `.describe()` so the derivation preserves the model-steering descriptions, and a PR check verifies the derived JSON is **at least as descriptive** as today's hand-written block. (A2 ports the descriptions now; Story 4 is where the derivation that consumes them lands.)
- Companion guards already noted for the migration: a hand-authored `inputJSONSchema` override on the recurrence tool (so `superRefine` `COUNT⇒count` / `UNTIL_DATE⇒endDate` guidance still reaches the model up front), nullable-`endAt` fidelity (`['string','null']`, not an `anyOf`/`oneOf` union), and pinning the derived-set semantics so `set_reminder` (deliberately in **neither** `WRITE_TOOLS` nor `SCHEDULE_FETCH_TOOLS`) does not silently start inflating `committedWrites` — cue's write-axis default is the **opposite** of CC's fail-closed-as-WRITE `TOOL_DEFAULTS`.

### Story 18 — DROP the cache-bug AC

- **Replace** Story 18's cache-bug acceptance criterion (which rested on the misdiagnosed "tools billed full-price" premise, L3) with a **comment-correction note**: tools are **already cached by breakpoint #1** (`tools` precedes `system` in the Anthropic prefix); fix the stale `tool-schemas.ts:236-240` comment + the dead `ToolSchema.cacheBoundary` path, optionally add `cache_read` observability, and **do not** wire a redundant tools breakpoint. The per-user persona block must still sit **below** breakpoint #1 (block 1 untouched) — that part of Story 18 stands.

---

## Deliberately NOT recommended

The gold-plating was weighed and refused; recorded so it is not re-litigated.

- **Already-rejected CC machinery** — ToolSearch/`defer_loading`, MCP adapter, sub-agent orchestration, parallel tool dispatch, plan mode, multi-stage compaction, and CC's manual raw-stream reassembler — remain correctly rejected (full rationale in [ADR 0016 §Alternatives](../adr/0016-assistant-ai-comms-audit-hardening.md)).
- **Backfill a synthetic `tool_result` for every `tool_use`** — cue's dispatch is total (every `toolCall` pushes a `roundResult`); no call is left unpaired, no 400 is possible. At most a dev-only `assert(roundResults.length === roundToolCalls.length)` tripwire.
- **Standardize a `<tool_use_error>`-style envelope across all `isError` outcomes** — cue's `is_error` mapping (`connector.ts:200`) already gives the model the structured signal; incremental steering, not a correctness fix. Fold into Story 4's dispatcher rework if done at all.
- **Per-tool semantic `validateInput` stage (two-stage validation)** — structure for structure's sake at ~9-tool scale; the few in-handler checks already return recoverable outcomes.
- **Standalone `REFUSAL` work item** — folded into the A1 `stopReason` switch. Refusals are rare in a single-calendar planner; not its own story.
- **Route terminal transport failures into the same alert sink as `correction_exhausted`** — sensible consistency add, but pure observability on a low-concurrency personal bot; a one-line follow-on once Story 1's sink exists.
- **CC's full `withRetry` generator + the 429-for-subscribers branch** — redundant with the SDK, and N/A: cue uses raw `ANTHROPIC_API_KEY` auth, so porting CC's subscriber-429-no-retry branch would wrongly disable retries on a legitimate rate-limit. Story 3 already scopes these out.

---

## Bottom line

The plan is in good shape and genuinely CC-literate. The reconciliation found **no new architecture to add** — the accepted items are small and surgical. The **five CODE-NOW fixes** (A1 terminal-handling overhaul, A2 `.describe()` port, A3 list caps, A4 cache-comment + observability, A5 graceful-failure net) land now while the relevant stories are still Draft. The **PLAN-HARDENING** corrections lock the v1/v2 stories — most pointedly Story 3 (529→fallback as the top Phase-B failure item), Story 13 (no-throw streaming), Story 4 (the `.describe()` AC + derivation guards), and Story 18 (drop the misdiagnosed cache-bug AC). Sequencing and the quality bar live in [ADR 0017](../adr/0017-assistant-ai-comms-implementation-scope.md); the four accepted hardenings in [ADR 0016](../adr/0016-assistant-ai-comms-audit-hardening.md).

## References

- Accepted decisions: [ADR 0016 — ai-comms audit hardening](../adr/0016-assistant-ai-comms-audit-hardening.md) · [ADR 0017 — ai-comms implementation scope](../adr/0017-assistant-ai-comms-implementation-scope.md)
- Stories touched: Stories 1/3/4 (shipped) in [ai-workflow](ai-workflow.md); Stories 13/18 (v2) in [ai-workflow-v2-plan](ai-workflow-v2-plan.md)
- Current behaviour: [ai-workflow.md](ai-workflow.md) §3 (caching), §6 (loop / terminal handling), §11 (resilience / failure net)
- Pattern source: `/Users/danil/personal-projects/claude-code-src/AI_COMMS_TOOLSET_RESEARCH.md`
