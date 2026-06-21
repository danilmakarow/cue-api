# AI workflow v2 — execution plan (canonical forward plan)

- **Status**: Authoritative forward plan for v2 (Stories 10–18). The **single** planning doc; supersedes and folds in the now-retired `ai-workflow-tasks.md` (v2 section) and `ai-workflow-v2-research.md`.
- **Last updated**: 2026-06-21
- **Owner**: @danil
- **Current state it evolves**: [ai-workflow](ai-workflow.md) (what ships today)
- **Deep designs**: [assistant-layered-architecture](assistant-layered-architecture.md) (the L0–L11 layer model + migration plan) · [assistant-tool-loop-redrive](assistant-tool-loop-redrive.md) · [assistant-task-tools](assistant-task-tools.md) · [recurrence-expansion](recurrence-expansion.md)
- **Decision records**: [ADR 0037 — v2 execution plan](../adr/0037-v2-execution-plan.md) (this plan's wave order + corrected assumptions) · [ADR 0011 — AI-judged conflicts (⟂ supersedes 0006 layer 4)](../adr/0011-assistant-ai-judged-conflicts.md) · [ADR 0012 — stateful messenger + draft streaming](../adr/0012-assistant-stateful-messenger-and-draft-streaming.md) · [ADR 0013 — message debounce + cancellation](../adr/0013-assistant-message-debounce-and-cancellation.md) · [ADR 0014 — per-user personality](../adr/0014-assistant-per-user-personality.md) · [ADR 0015 — daily-report scheduler](../adr/0015-assistant-daily-report-scheduler.md) · [ADR 0010 — stateful `ask_user` resume](../adr/0010-assistant-ask-user-stateful-resume.md) · [ADR 0006 — conflicts (layer 4 superseded)](../adr/0006-assistant-schedule-context-and-conflicts.md)

---

## Status / context

**v1 is shipped.** Stories 1–9 (loop correctness, `ask_user`, batch tools, the connector hardening) **and** the Story 8 layered decomposition are **SHIPPED and committed** — baseline `85fb290` + the Story 8 convergence at `ebd5ae3` ([ADR 0036](../adr/0036-assistant-turn-runner-convergence.md)). The assistant now runs on a clean **L0–L11** layer model (ingress · intake · router · turn lifecycle · orchestration loop · tools · context · domain · conflict · reply · AI transport · background+alerts — see [assistant-layered-architecture §the layer model](assistant-layered-architecture.md#the-layer-model)), with the bounded agent loop vendor/Redis/ORM-blind behind the `AiConnector` port, the reply presenter (L9) as the sole `vendor.send*` caller, and the deterministic ADR-0006 conflict hold physically isolated at L8.

**v2 builds additively on those layers.** Stories 10–18 add the conversational UX — an instant living status message, native response streaming, message debounce/coalescing + STOP, AI-judged conflicts, reply-keyboard navigation, daily reports, and per-user personality. Each lands as a new method/layer onto the existing L0–L11 model, **not** a rewrite. The single fact that reshaped the whole UX: Telegram's `sendMessageDraft` is a purpose-built ephemeral streaming primitive that is *both* the live-status surface and the response-streaming surface.

---

## Verified Telegram streaming facts

Distilled from adversarial re-verification against the live Telegram Bot API docs. These supersede the earlier recon; two corrections were applied (see the inline ⚠️/note markers).

- **`sendMessageDraft`** (Bot API **9.3**; available to **all bots since 9.5**) is the purpose-built streaming primitive. Verbatim: *"stream a partial message to a user while the message is being generated… the streamed draft is ephemeral and acts as a temporary 30-second preview — once the output is finalized, you must call sendMessage with the complete message to persist it."* Source: https://core.telegram.org/bots/api#sendmessagedraft
  - Params (official order): `chat_id` (req), `message_thread_id` (opt), `draft_id` (req, **non-zero integer**), `text` (opt), `parse_mode` (opt), `entities` (opt).
  - **Repeated calls with the same `draft_id` animate the transition natively client-side** — that *is* the update mechanism; there is no "edit draft" variant.
  - **Empty-text `text` ⇒ a native "Thinking…" shimmer placeholder.** (Correction: empty-text support landed in **Bot API 10.0**, 2026-05-08 — not 10.1.)
  - **Private chat only.** Non-private chats degrade to `editMessageText` (≤ 1/s on a real message).
  - **A draft MUST be finalized with a real `sendMessage`** (or `editMessageText`) to persist — the draft itself never survives the 30 s TTL.
- **`sendRichMessageDraft`** (Bot API **10.1**, 2026-06-11) is the rich/structured-content variant: `chat_id`, `message_thread_id?`, `draft_id`, `rich_message: InputRichMessage` (requires **exactly one** of `html`/`markdown`); finalize with `sendRichMessage`. Source: https://core.telegram.org/bots/api#inputrichmessage. **v2 ships plain `sendMessageDraft` only**; rich drafts are a later opt-in (needs 10.1+ clients). (Note: `business_connection_id` is **not** a parameter of either draft method — the wrapper-library "required" claim is an artefact.)
- **Drafts carry NO buttons.** Any inline control (STOP) must ride a **separate real message** via `sendActions`, never the draft.
- **`editMessageText`** shares the per-chat send budget (~1 msg/s/chat; HTTP 429 + `retry_after` above it; community-observed edit ceiling ~6/s global). A 25 ms / ~40-edits-per-second cadence is **definitively infeasible** and unnecessary — the client animates a draft from same-`draft_id` re-calls. Source: https://core.telegram.org/bots/faq · https://grammy.dev/advanced/flood
- **Reply-keyboard taps arrive as plain text equal to the button label** (NOT `callback_query`); a persistent keyboard (`is_persistent: true`, `resize_keyboard: true`, Bot API 6.4) is swapped by sending a **new** message, removed via `ReplyKeyboardRemove`. Source: https://core.telegram.org/bots/api#replykeyboardmarkup · https://grammy.dev/plugins/keyboard
- **Telegram delivers no inbound "user is typing/recording" signal to bots** — "wait while the user types" is only approximable by re-arming a debounce on rapid follow-ups.

> ⚠️ **Load-bearing UNKNOWN — the draft-call throttle is UNDOCUMENTED.** The live docs state only the 30 s TTL; there is **no** published rate limit or throttling exemption for draft calls (and the "drafts bypass `editMessageText` limits" framing is an undocumented inference, not a fact). **Cap all draft calls conservatively at ~2–5/s, centrally, in the L9 egress layer** so every draft caller (status animation, streaming) inherits the cap. Re-verify against the live docs before raising it.

---

## Per-story table

Layers reference the [L0–L11 model](assistant-layered-architecture.md#the-layer-model). "Depends-on" lists v2 stories unless prefixed `v1-` (a shipped v1 story).

| id | one-line | layer(s) | risk | depends-on | key acceptance |
|---|---|---|---|---|---|
| **10** | Messenger port: draft/edit/keyboard primitives + Redis `StatusSession` | L9 | low | — | port + connector gain `editMessageText` / `sendChatAction` / `deleteMessage` / `sendMessageDraft` + persistent reply-keyboard; draft gated to `chat.type==='private'`; `StatusSession` is Redis-backed, idempotent (no orphaned 2nd message); the finalize-with-real-`sendMessage` contract is documented on the port |
| **11** | Per-user serialization lock (shared Redis mutex) | L3 | low | — | `assistant:lock:{userId}` `SET NX PX` + watchdog renew, released by token in `finally`; auto-expires (no deadlock on crash); shared by Story 14 queue-after **and** v1 `ask_user` resume double-resume race |
| **12** | Live status message — cycling words + dots + voice state | L9 + L1 | med | 10 | immediate empty-text draft ("Thinking…") within ~1 s; word cycles every 5 s (locale vocab); trailing dots animate every 500 ms via same-`draft_id` re-calls; **voice ⇒ "Listening to your beautiful voice"** until STT returns; `setInterval` cleared in `finally`; combined rate ≤ ~2–5/s; non-private ⇒ static line |
| **13** | Native response streaming + per-step recaps | L10 + L9 + L11 | med | 10, 12, v1-#3 | `completeStream(request, onText)` over the installed SDK's `client.beta.messages.stream()` + `finalMessage()` (no upgrade); final round streams to draft (throttled ≤5/s) then finalizes with a real `sendMessage`; per-round 1-sentence recap by the **BACKGROUND (Haiku)** model into the status draft; **`completeStream` MUST return, never throw** — partial-draft reconcile / fallback-on-empty-stream (the loop never sees a throw; honours `attempts:1`) |
| **14** | Debounce + combine-coalescing + queue-after + STOP | L1 + L3/L4 + L9 | **high** | 10, 11 | ~2 s per-user Redis debounce (BullMQ `delay`), re-armed on each inbound; window messages **combined by concatenation in arrival order** (never silently dropped); mid-turn message **queued-after** under the Story 11 lock (never cancels) via a **fresh unique drain job** (a re-poll armed from inside the active job must not reuse the active stable jobId — real BullMQ ignores it); an `ask_user` **answer is NOT combined but IS serialized** under the same lock (queues-after on a held lock, never races a simple-message turn); **STOP** = separate real message (`stop:` callback) checked between rounds + after each write; STOP **keeps committed writes** and replies with a **programmatic** (no AI call) summary from the `rounds[].steps` ledger |
| **15** | AI-judged conflicts (remove the deterministic hold) | L8 → L5/L4 + L6 | **high** (safety) | v1-#5 (`ask_user`) | deletes the L8 deterministic hold (`holdAndAsk`/`executeHeldBatch`/`buildHeldPrompt`/`kind:'held'`/`confirm:`/`cancel:`/`HeldConflictBatch`/held TTL+key) — **keeps `TaskService.findOverlapping`**; dispatcher returns the overlap as a **recoverable `isError` tool result** restating default-deny; model proceeds only on explicit in-message auth **or** a user-set durable `conflict_policy` `UserMemoryFact`, else `ask_user`; destructive replace always asks; default-deny stated in prompt **and** every conflict tool-result |
| **16** | Reply-keyboard controls + ASCII calendar + latest-button context | L9 + L2 + L7 | low | 10 | persistent `[Today's schedule] [Next week] [Settings]`; Settings ⇒ `[Disconnect] [Back]`; taps routed by **text-equality on the label, only when the reply keyboard is the active surface**; Today/Next week render a monospace ASCII calendar (≤ ~30 chars/line) from `TaskService.findOccurrencesInRange`; latest button result stored in `assistant:lastButton:{userId}` (overwrite) and injected into the next turn's **volatile tail** (never the cached prefix, ADR 0004) |
| **17** | Per-day notification reports | L7 + L11 | med | **delivery worker** (see gating prereq) | `UserReportSettings` entity + migration; REST `GET`/`PATCH /users/me/report-settings` behind `AccessTokenGuard` (+ `openapi.yaml`); per-minute `@nestjs/schedule` job scans opted-in users whose `User.timezone` local time matches `reportTimeLocal` (luxon), **idempotent** via per-user last-sent-date guard; one AI request → one response (no tool loop); Telegram exposes no config |
| **18** | Per-user AI personality | L6 + L7 | low | — | `PersonaPrompt` entity + repo + DatabaseService + migration + seeded "Jarvis" preset; REST `GET`/`PATCH /users/me/persona-settings` (+ `openapi.yaml`); persona injected as a `PromptBlock` **between profile/groups and the rolling summary, with NO `cacheBoundary`** (per-user region closed by breakpoint #2); **block 1 untouched** — see Corrected Assumption 1 |

---

## CORRECTED ASSUMPTIONS (critical)

These four corrections bind the plan. They are the load-bearing deviations from the retired research/backlog docs; read them before picking up any story.

### 1. Story 18 — the "tool defs billed full price every turn" cache bug is a MISDIAGNOSIS; the cache-bug AC is DROPPED

The original framing claimed the tool definitions are paid at full price every turn because no `ToolSchema` sets `cacheBoundary`. **This is wrong (audit L3 / [ADR 0016 A4](../adr/0016-assistant-ai-comms-audit-hardening.md) · [ai-comms audit §A4/§B](ai-comms-cc-audit.md)).** In Anthropic's prefix order the `tools` block **precedes** `system` (`context-builder.service.ts:275`), so tools are **already cached by breakpoint #1** — they do not need their own boundary. The stale comment at `tool-schemas.ts:236–240` (claiming the last schema "carries `cacheBoundary`") and the dead `ToolSchema.cacheBoundary` path (`ai.types.ts:74`, `connector.ts:253`, grep count = 0) are simply false/dead — fix or delete the comment + dead path, but **do NOT wire a redundant tools `cacheBoundary`.** The Story 18 acceptance criterion about the cache bug is **DROPPED**; Story 18 ships only the per-user persona placed below breakpoint #1, leaving block 1 byte-stable.

> The retired `ai-workflow-v2-research.md §G` (~line 199) still carried the stale "latent cost bug" framing — that was **the single most stale line in the research**. It dies with this correction and with that doc's retirement.

### 2. Story 15 SUPERSEDES the ADR-0006 layer-4 deterministic hold — SAFETY-CRITICAL

Story 15 moves a **deterministic** double-book guard to **model judgement**, so it is the safety-critical story of v2. It deletes the L8 deterministic hold (and the `confirm:`/`cancel:` `HeldConflictBatch` path) and replaces it with: a **strict default-deny** policy stated firmly in the system prompt, plus the dispatcher returning each overlap as a **recoverable `isError` tool_result** that restates the conflict and the default-deny rule. The model proceeds over a conflict **only** on explicit in-message authorization or a user-set durable `conflict_policy` `UserMemoryFact` (**never inferred**); otherwise it calls `ask_user`; any destructive replace requires an explicit `ask_user` first. This is already framed by [ADR 0011](../adr/0011-assistant-ai-judged-conflicts.md) (Accepted, ⟂ supersedes [ADR 0006](../adr/0006-assistant-schedule-context-and-conflicts.md) layer 4). **Merge gate** = default-deny in both prompt and every tool-result + the dispatcher's recoverable-`isError` restatement; the 5 held-specific `assistant.service.spec.ts` cases + 2 in `tool-dispatcher.service.spec.ts` are replaced with AI-judged-conflict cases. **Depends on v1 Story 5 `ask_user` (SHIPPED).**

### 3. Story 17 is BLOCKED on a ScheduledNotification delivery worker that does NOT yet exist

[notification-delivery.md](notification-delivery.md) is still **Draft** — `ScheduledNotification` is a schema-only outbox and **no delivery worker exists**. Story 17's per-day report has nowhere to send. **Gating prerequisite: sequence the delivery worker first** (a BullMQ worker polling `status = PENDING AND fireAt <= now`, then the channel clients), **or** send the report **directly through the Telegram connector as an interim**. Story 17 cannot be merged as "done" until one of those two delivery paths exists; the interim direct-send is the lower-lift unblock.

### 4. Draft-call throttle — conservative ~2–5/s cap is MANDATORY

The draft-update throttle is **undocumented** (see Verified facts). Every draft caller (Story 12 status animation, Story 13 streaming) **must** route through one central ~2–5/s cap in the L9 egress layer. The 500 ms dot tick (2/s) and the 5 s word swap are safely under it; per-token streaming is **not** — batch deltas. Do not raise the cap without re-verifying the live docs.

---

## Wave order

Discipline for every wave: **one ADR per wave**, every change gated by `pnpm run lint` + `pnpm run type` + `pnpm jest`, an **e2e run at each wave's end**. Behaviour-preserving where a story touches shipped paths; the 4 ADR-0006 cases stay the merge gate until Story 15 deliberately replaces them.

### Wave A — Foundation (parallel)
**Story 10 + Story 11.** Both are dependency-free primitives that everything else builds on — the stateful messenger surface (L9) and the per-user lock (L3). They touch disjoint code (connector/egress vs. turn lifecycle) and can run in parallel.

### Wave B — Status / streaming core
**Story 12 (needs 10) → Story 13 (needs 10, 12).** Once the draft primitive and `StatusSession` exist, the live status message (12) lands first; native streaming + per-step recaps (13) then reuses the same draft surface and the v1-shipped connector. Sequential because 13 streams *into* the status draft 12 establishes.

### Wave C — Message-flow control
**Story 14 (needs 10, 11).** Isolate it: it is the **highest behavioural-risk** story — STOP / partial-write semantics / the `attempts:1` coupling / debounce-window combine-vs-drop / queue-after racing all interact. Land it alone, behind its own ADR (0013), with the per-user lock (11) already in place.

### Wave D — Conflict reversal
**Story 15.** Safety-critical and deliberate: it **deletes** the L8 deterministic hold and hands the call to model judgement under default-deny. Land it on its own (ADR 0011 already written), with v1 `ask_user` proven, and the held-spec replacement as the explicit merge gate. Do not bundle it with anything.

### Wave E — Independent add-ons
**Story 16 (needs 10), Story 18 (independent), Story 17 (needs the delivery-worker prerequisite first).** Reply-keyboard navigation (16) and per-user personality (18) are independent feature surfaces; 17 trails because of its delivery-worker gating prerequisite (Corrected Assumption 3) — sequence the worker (or interim direct-send) ahead of it.

---

## Appendix A — Loading vocabulary (Story 12)

Single evocative words; the animating dots are appended (`Готую…`). Selected by Telegram `language_code` (`uk` / `ru` / else `en`); cycle every 5 s, no immediate repeat. Suggested home: `assistant/status-phrases.ts`.

**Voice state** (shown while transcribing, before normal loading):
- `en`: **Listening to your beautiful voice**
- `uk`: **Слухаю ваш чудовий голос**
- `ru`: **Слушаю ваш прекрасный голос**

**English (30):** Thinking · Cooking · Brewing · Plotting · Pondering · Conjuring · Scheming · Crunching · Dreaming · Weaving · Calculating · Summoning · Orchestrating · Composing · Untangling · Aligning · Sketching · Percolating · Mulling · Noodling · Assembling · Wrangling · Charting · Distilling · Forging · Marinating · Daydreaming · Tinkering · Synthesizing · Manifesting

**Українська (30):** Думаю · Готую · Заварюю · Планую · Міркую · Чаклую · Рахую · Мрію · Плету · Складаю · Креслю · Майструю · Зважую · Вигадую · Кумекаю · Метикую · Збираю · Налаштовую · Компоную · Розплутую · Шукаю · Прикидаю · Обмірковую · Ворожу · Фантазую · Мудрую · Накидаю · Узгоджую · Творю · Готуюся

**Русский (30):** Думаю · Готовлю · Завариваю · Планирую · Кумекаю · Колдую · Считаю · Мечтаю · Плету · Собираю · Черчу · Мастерю · Взвешиваю · Придумываю · Соображаю · Прикидываю · Размышляю · Настраиваю · Компоную · Распутываю · Ищу · Ворожу · Фантазирую · Мудрю · Набрасываю · Согласую · Творю · Стряпаю · Замышляю · Химичу

---

## References

- Current as-built state: [ai-workflow](ai-workflow.md)
- Layer model + migration plan: [assistant-layered-architecture §the layer model](assistant-layered-architecture.md#the-layer-model)
- Decision for this plan: [ADR 0037 — v2 execution plan](../adr/0037-v2-execution-plan.md)
- Per-story decision records: [ADR 0011](../adr/0011-assistant-ai-judged-conflicts.md) · [ADR 0012](../adr/0012-assistant-stateful-messenger-and-draft-streaming.md) · [ADR 0013](../adr/0013-assistant-message-debounce-and-cancellation.md) · [ADR 0014](../adr/0014-assistant-per-user-personality.md) · [ADR 0015](../adr/0015-assistant-daily-report-scheduler.md) · [ADR 0010](../adr/0010-assistant-ask-user-stateful-resume.md)
- AI-comms audit (Corrected Assumption 1 source): [ai-comms-cc-audit §A4/§B](ai-comms-cc-audit.md) · [ADR 0016](../adr/0016-assistant-ai-comms-audit-hardening.md)
- Story 17 delivery prerequisite: [notification-delivery](notification-delivery.md)
- Telegram Bot API: https://core.telegram.org/bots/api#sendmessagedraft · https://core.telegram.org/bots/api#inputrichmessage · https://core.telegram.org/bots/api#replykeyboardmarkup · https://core.telegram.org/bots/faq · https://grammy.dev/advanced/flood · https://grammy.dev/plugins/keyboard
</content>
</invoke>
