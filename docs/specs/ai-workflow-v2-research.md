# AI Workflow v2 — Research Dossier

- **Status**: Draft (research synthesis — not yet an approved design)
- **Last updated**: 2026-06-19
- **Owner**: @danil (lead engineer synthesis)
- **Related ADRs**: [0004](../adr/0004-assistant-prompt-composition-and-caching.md) · [0005](../adr/0005-assistant-conversation-memory-model.md) · [0006](../adr/0006-assistant-schedule-context-and-conflicts.md) · [0007](../adr/0007-provider-connector-abstraction.md) · [0009](../adr/0009-assistant-narration-redrive.md) · [0010](../adr/0010-assistant-ask-user-stateful-resume.md)

## Purpose & how to read this

This dossier synthesizes recon over the live Telegram Bot API docs and over the `cue-api` codebase to plan a major v2 of the Telegram AI assistant. Each feature area (A–G) lists: **Verified facts** (with doc URLs or `file:line` citations), **cue-api touch-points**, **Risks**, and a **Recommended approach**. Product-owner decisions that an engineer cannot make alone are collected in the workflow output (and summarized in [§ Decisions](#decisions-for-the-product-owner)).

**Two corrections to the input recon were applied and are flagged inline:**

1. **`sendMessageDraft` is NOT documented as bypassing edit throttling.** An adversarial re-verification against the live Telegram docs found *no* rate-limit text in either draft method's section. The "drafts bypass `editMessageText` limits" framing is an undocumented inference, not a fact. Treat throttling as unknown and throttle conservatively. (Verify findings, claim 3 = `unverifiable`.)
2. **The `ask_user` tool is already an Accepted ADR (0010), not a green-field idea.** Recon said "`ask_user` does not exist anywhere." That is true of `src/` (it is unimplemented), but [ADR-0010](../adr/0010-assistant-ask-user-stateful-resume.md) (dated 2026-06-19, Accepted) **fully specifies** a stateful Postgres+Redis suspend/resume for it. Feature D must build on 0010, not reinvent it. Likewise [ADR-0009](../adr/0009-assistant-narration-redrive.md) (narration re-drive) constrains features B and D.

---

## A. Stateful messenger adapter (status message + cycling word + voice state)

### Verified facts

- **No edit / typing / draft / delete method exists on the messenger port today.** `ExternalVendorConnector` exposes only `sendMessage`, `sendActions`, `acknowledgeCallback`, `fetchMedia`, `registerWebhook`, `removeWebhook` — `external-vendor-connector.abstract.ts:57-91`. The concrete Telegram client is raw `fetch` with a private generic `callApi<T>(method, body)` helper — `telegram-vendor.connector.ts:113-136`. **No SDK** (grammY/Telegraf) is a dependency (`package.json`).
- **`editMessageText` exists in Telegram and shares the per-chat send budget.** Official guidance is ~1 message/sec per chat; exceeding returns HTTP 429 with `retry_after` (https://core.telegram.org/bots/faq). Edit-specific limits are **not officially published**; community-observed ceiling is ~6 edits/sec global / ~20 edits/min per group (https://grammy.dev/advanced/flood). **A 25 ms cadence (~40 edits/sec) is definitively infeasible via `editMessageText`** and will 429.
- **`sendMessageDraft` is the purpose-built streaming primitive (Bot API 9.3, all bots since 9.5).** Verbatim: *"Use this method to stream a partial message to a user while the message is being generated… the streamed draft is ephemeral and acts as a temporary 30-second preview - once the output is finalized, you must call sendMessage with the complete message to persist it"* (https://core.telegram.org/bots/api#sendmessagedraft). Params (official order): `chat_id` (req), `message_thread_id` (opt), `draft_id` (req, non-zero), `text` (opt; **empty string ⇒ "Thinking…" placeholder**), `parse_mode` (opt), `entities` (opt). **Empty-text support landed in Bot API 10.0 (2026-05-08)**, not 10.1 (changelog correction). **Private chat only.**
- **Repeated calls with the same `draft_id` animate the update natively client-side** — that *is* the update mechanism; there is no "edit draft" variant.
- ⚠️ **No documented rate limit or throttling exemption for draft calls.** The 30-second TTL is the only ephemerality statement in the live docs. (Verify, claim 3.)

### cue-api touch-points

- **Add three methods to the abstract port + Telegram connector**: `editMessageText(target, vendorMessageId, message)`, `sendChatAction(target, action)`, `deleteMessage(target, vendorMessageId)` — each is a thin `callApi('<method>', body)` add; the connector needs no structural change.
- **Add a `sendMessageDraft(target, draftId, text)`** method on the port (private-chat-gated) for the animation/streaming surface (shared with feature C).
- **A `StatusMessage` value object** (Redis-backed, **not** a DB entity) holding `{ chatId, messageId | draftId, phase, animationTimer? }`, threaded through `WebhookConsumer.process() → AssistantService.handleText/handleCallback()` as a new optional `statusRef` param.
- **The animation loop** (`setInterval` cycling the status word every ~2 s) is created at job start and **must be cleared in a `finally`** in `WebhookConsumer.process()` — BullMQ `WorkerHost.process()` is async, so a top-level try/finally there is the correct home. No timer mechanism exists anywhere today.
- **Voice "Listening to your beautiful voice" state**: hook is `webhook.consumer.ts:transcribeVoice()` (`~line 96`), immediately before `connector.fetchMedia()` and again after `stt.transcribe()` returns. Two sequential awaits give natural transition points; no state machine needed.

### Risks

- **BullMQ retry orphaning.** The queue is registered name-only (`assistant.module.ts:41`) and the dedupe guard is *deleted on failure* (`webhook.consumer.ts:243`), so a retry re-enters fresh and could spawn a **second** status message. Note: [ADR-0009](../adr/0009-assistant-narration-redrive.md) records the queue is **`attempts: 1`** — so today there is no retry, and the orphan risk is theoretical *until* attempts is raised. If v2 raises attempts, status creation must be idempotent (check Redis for an existing `statusMessageId` before creating).
- **`setInterval` leak** if the job is killed mid-flight — must clear in `finally`.
- The 25 ms micro-animation cadence the brief asks for is **not achievable** as real Telegram edits (see Decision 1). Drafts animate client-side from a *single* call, so the "micro-animation" should be a client-rendered draft animation or a ~2 s word cycle, not 40 edits/sec.

### Recommended approach

Use **`sendMessageDraft` with a stable per-turn `draft_id`** as the status/animation surface in private chats: one immediate empty-text call ("Thinking…"), then re-call with the same `draft_id` as the status WORD cycles (loading → thinking → cooking → brewing → planning → dreaming) on a ~2 s timer. Finalize the turn with a real `sendMessage` (and persist its `message_id` into `ConversationMessage.vendorMessageId` as today, `conversation-message.entity.ts:71-77`). Keep `editMessageText` only as a **fallback for non-private chats / pre-9.5 clients**, rate-limited to ≤1/s. Gate all draft use behind `chat.type === 'private'`.

---

## B. Debounce + coalescing + queueing + cancellation (STOP)

### Verified facts

- **Each inbound message is one BullMQ job today.** Webhook controller hashes the body (SHA-256 `jobId`) and enqueues `'inbound'` then returns 200 (`assistant-webhook.controller.ts:108-116`). Dedup is Redis `SET NX` keyed `assistant:dedupe:{vendor}:{dedupeId}` (`webhook.consumer.ts:67-79`). **There is no debounce, no coalescing, no queue-after, and no cancellation primitive.**
- **The loop runs to completion with no interrupt point.** `runToolLoop` (`assistant.service.ts`) is a synchronous-from-the-job's-view `for` loop over `ai.complete()` + tool dispatch; there is no `await-user` primitive and no cancellation token.
- **The queue is `attempts: 1`** ([ADR-0009](../adr/0009-assistant-narration-redrive.md)); a throw does **not** replay. This is load-bearing for STOP semantics: writes already committed will *not* be re-run, so a STOP that abandons the job leaves committed writes in place by construction.
- **Telegram has no protocol-level "user is typing/recording" signal delivered to bots** for *inbound* messages. Telegram surfaces `sendChatAction` (bot→user) but does not push the *user's* typing state to the bot via webhook. "Keep waiting while the user is typing/recording" is therefore **not directly observable** — it can only be approximated by treating a rapid follow-up message as evidence the user was mid-thought.

### cue-api touch-points

- **A debounce/coalescing layer in front of the job**, keyed by user + message timestamp. Natural home: a Redis key `assistant:debounce:{userId}` holding the pending message(s) with a ~2 s delayed BullMQ job (`delay` option), re-armed on each new inbound during the WAIT window.
- **Cancellation needs a cooperative checkpoint** inside `runToolLoop` — the loop reads a Redis `assistant:stop:{correlationId}` flag (or AbortSignal) between rounds and after each write, then exits early.
- **STOP button** = an inline keyboard (reuses `sendActions`) with a new callback prefix (distinct from `confirm:`/`cancel:`/`ask:` — see ADR-0006/0010). The `handleCallback` path (`assistant.service.ts:809-877`) is where it routes.
- **"Summary of writes already made"**: the loop already accumulates committed writes per round (`rounds[].steps`, `assistant.service.ts:376-458`); a STOP exit reuses that to build the summary.

### Risks

- **Coalescing vs. ordering.** If a WAIT-window message *drops/coalesces* the prior, a user who sends "create lesson A" then "actually make it B" must get B — last-wins is safe; but "create A" then "and also B" must **combine**, not drop. The two cannot be distinguished syntactically without the model. This is the core product decision (Decision 3).
- **Queue-during-ACTIVE racing.** A second message during processing, queued to run after, races the first job's writes and its own debounce. The held-question/ask_user resume ([ADR-0010](../adr/0010-assistant-ask-user-stateful-resume.md)) already notes "two inbound updates while a question is pending race; compare-and-set blocks double-resume, a per-user advisory lock would close it fully" — the same per-user serialization is needed here.
- **STOP partial-write semantics.** With `attempts: 1`, abandoning mid-loop leaves committed rows; a rollback would need an explicit compensating delete of this turn's writes — non-trivial and risky (Decision 5).
- **No true typing/recording signal** — the "keep waiting while typing" requirement is only approximable (see facts).

### Recommended approach

Implement a **per-user debounce window** (Redis-keyed, ~2 s, re-armed on each inbound) that **collapses WAIT-window messages into one turn by concatenation** (combine, not last-wins — preserves "and also…"), then a **per-user processing lock** so a message arriving during ACTIVE processing is enqueued as a follow-up turn (queue-after, not cancel-prior). STOP sets a Redis flag the loop checks **between rounds and after each write**; on STOP it **keeps committed writes and replies with a summary of them** (matches `attempts: 1` reality; rollback is a much larger lift). Decisions 3 and 5 confirm the coalescing and STOP-rollback postures.

---

## C. Native streaming drafts + per-step recap in the status message

### Verified facts

- **`sendMessageDraft` / `sendRichMessageDraft` confirmed against live docs** (see § A and § Verify). `sendRichMessageDraft` (Bot API 10.1, 2026-06-11) takes `chat_id`, `message_thread_id?`, `draft_id`, `rich_message: InputRichMessage`; finalize with `sendRichMessage`. `InputRichMessage` requires **exactly one** of `html` / `markdown` (plus optional `is_rtl`, `skip_entity_detection`) (https://core.telegram.org/bots/api#inputrichmessage).
- **`business_connection_id` is NOT a parameter of either draft method** in the official table — the `tgram` library's "required" claim is a wrapper artefact (Verify, overall note a).
- **The AI connector is fully non-streaming today.** `complete(): Promise<CompletionResult>` (`ai-connector.abstract.ts:31`) awaits the full `Message` (`anthropic-ai.connector.ts:490-504`). **The installed SDK `@anthropic-ai/sdk@^0.100.1` already exposes `client.messages.stream()`** returning `MessageStream` with `.on('text', (delta, snapshot) => …)` and `stream.finalMessage()` (`node_modules/@anthropic-ai/sdk/lib/MessageStream.d.ts:9,108`) — **no SDK upgrade needed.**
- **The per-step recap insertion point is exact**: `assistant.service.ts:447-458`, after `rounds.push()` / `toolRounds.push()` and before the next `ai.complete()`. The `steps[]` array already carries `{ name, input, resultContent (≤2000 chars), isError }`.

### cue-api touch-points

- **Add `completeStream(request, onText)`** to the AI port; implement via `client.messages.stream()` + `finalMessage()` normalized through the existing `toCompletionResult()`. `CompletionResult` shape is unchanged.
- **Add `streaming: boolean`** to `AiCapabilities` (`ai.types.ts:180-184`) — consistent with the existing `structuredOutput` flag.
- **Per-step recap**: generate a 1-sentence recap from `steps[]` and push it into the **status message draft** (feature A surface), *not* into the cached system blocks. Per [§G / ADR-0004], any recap that touches the prompt must live in the **volatile messages tail**, never the cached prefix.

### Risks

- ⚠️ **Streaming + context-editing beta is unverified.** The context-editing path uses `client.beta.messages.create()` (NonStreaming overload, `CONTEXT_MANAGEMENT_BETA = 'context-management-2025-06-27'`). Whether `client.beta.messages.stream()` exists in 0.100.1 must be checked before combining streaming with context-editing.
- **Throttle is unknown** for draft updates (Verify, claim 3). Batch deltas to ~2–5 updates/sec, not per-token.
- **Recap cost/UX trade-off.** Reusing the **main** model to narrate mid-turn changes the final-reply UX and needs prompt surgery; a **Haiku (BACKGROUND role) `completeStructured`** recap per round costs ~$0.00025/recap (~$0.0012 for a 5-round turn) and keeps the main reply intact.

### Recommended approach

Stream the **final** (end_turn) round's text via `completeStream` → throttled `sendMessageDraft` (≤5 updates/s), finalize with `sendMessage`. For per-step recaps, use the **BACKGROUND (Haiku) model** to turn `steps[]` into one sentence and write it to the **status draft** between rounds — deterministic, cheap, and it leaves the main model's reply untouched. Default to **plain `sendMessageDraft`**; reserve `sendRichMessageDraft` for a later opt-in (it needs 10.1+ clients and a richer formatter) — see Decision 2.

---

## D. AI-judged conflicts replacing the ADR-0006 deterministic hold

### Verified facts

- **The ADR-0006 hold is deterministic and never re-invokes the model.** The dispatcher detects overlaps on non-recurring timed creates (`tool-dispatcher.service.ts:376-393`) and one-off timed moves (`:608-626`) via `TaskService.findOverlapping` (`task.service.ts:637-643`), returns a `heldConflict` instead of writing; the orchestrator batches them into Redis `assistant:held:<uuid>` (TTL default 600 s) and prompts with inline buttons `confirm:<token>` / `cancel:<token>`; the callback executes the batch **without any model call** (`assistant.service.ts:566-877`). Recurring writes deliberately have **no hold** (`:482-577`).
- **`ask_user` is already Accepted as [ADR-0010](../adr/0010-assistant-ask-user-stateful-resume.md)** (2026-06-19) but **unimplemented in `src/`** (no `PendingQuestion` entity, no `ask_user` schema — confirmed by grep). 0010 specifies: a `pending_question` Postgres row (system of record) mirrored to Redis (30-min TTL); atomic idempotent claim via `GETDEL` **or** `UPDATE … WHERE status='AWAITING' RETURNING *`; button `ask:<id>:<opt>` resumes from Postgres up to `ASSISTANT_ASK_USER_RETENTION_HOURS` (default 168); free-text only resumes inside the hot window; **exactly one synthetic `tool_result`** appended on resume (Anthropic 400 otherwise). 0010 explicitly keeps the **conflict hold Redis-only/ephemeral** and **separate** from `ask_user` ("a stale overlap must expire, not resurrect").
- **The narration re-drive ([ADR-0009](../adr/0009-assistant-narration-redrive.md))** already classifies `end_turn`-with-no-tools turns and re-drives the model with `tool_choice: 'any'` for zero-commit non-questions — so v2's "model decides, else asks" must reuse this classifier, not fight it.

### cue-api touch-points

- **Delete the deterministic hold**: `heldCreateOutcome`/`heldUpdateOutcome` and both `findOverlapping`-on-write guards in the dispatcher; `holdAndAsk`, `executeHeldBatch`, `buildHeldPrompt`, the `kind:'held'` branch and `ConflictCallbackAction`/`HeldConflictBatch` types in the assistant service/types; `heldConflictTtlSeconds` config + the env var. **KEEP `TaskService.findOverlapping`** — it becomes the backend the dispatcher uses to *describe* a conflict to the model.
- **Change the dispatcher**: on overlap, return a recoverable `{ content: 'Conflict: overlaps "<title>" (<start>–<end>). Default: do NOT proceed unless the user explicitly accepted.', isError: true }` tool result, so the model decides.
- **`ask_user`** is the escalation path — implement per ADR-0010 (new `pending_question` entity + repo + DatabaseService + migration + `@nestjs/schedule` cleanup job + `ask:` callback resolver).
- **Durable "conflicts OK" preference** (if chosen): a `UserMemoryFact` of `type='preference'`, `key='conflict_policy'`, `value={policy}` (explicit source) read into the profile block (`user-memory-fact.entity.ts`; rendered by `context-builder.service.ts:78-94`). There is no dedicated enum value today.
- **Delete/replace the five held-specific specs** in `assistant.service.spec.ts` and two in `tool-dispatcher.service.spec.ts`.

### Risks

- **Default-deny enforcement is now the model's job.** A deterministic gate is being replaced by a judgement; a prompt regression could let the model silently double-book. The system prompt must state the default-NOT-acceptable rule firmly and the dispatcher's `isError` content must restate it every time.
- **"What to delete/keep"** on an accepted conflict: the current `update_event` held action carries only `taskId/startAt/endAt`; if the model is to *replace* an existing event it needs an explicit delete path that bypasses `findOverlapping` (Decision on safety posture).
- **Recurring conflicts remain deferred** unless explicitly pulled in — an expanded series clashing on many dates does not fit a single ask.
- **Dead config**: removing the hold strands `ASSISTANT_HELD_CONFLICT_TTL_SECONDS` and the `heldConflictKey` constants — clean them up to avoid drift.

### Recommended approach

Replace the hold with a **model-judged conflict**: dispatcher returns conflict detail as an `isError` tool result with a **default-deny** instruction; the model proceeds only if user facts/message explicitly authorize it, otherwise calls **`ask_user` (ADR-0010)**. Make **"conflicts OK" a durable, explicit `UserMemoryFact`** (not a per-message guess) so the policy is auditable and stable — but **only when the user sets it explicitly** (the inferred extractor is too noisy for a safety-relevant flag). For "what to delete/keep," default to **keep both** (additive) and require an explicit `ask_user` before any destructive replace. See Decisions 4 and 6.

---

## E. Persistent reply keyboard + ASCII calendar + latest-button-result context

### Verified facts

- **Reply-keyboard taps arrive as plain text messages equal to the button label — NOT `callback_query`.** There is no protocol-level distinction from a user typing the same text (https://grammy.dev/plugins/keyboard; https://core.telegram.org/bots/features#keyboards). Handle via text-match.
- **You cannot edit a message to change a persistent keyboard** — replacing requires sending a **new** message with the new `ReplyKeyboardMarkup`; removing requires `ReplyKeyboardRemove` (`{ remove_keyboard: true }`).
- **`is_persistent: true`** (Bot API 6.4) keeps the keyboard visible when the system keyboard is hidden; **`resize_keyboard: true`** keeps it compact (https://core.telegram.org/bots/api#replykeyboardmarkup).
- **The current connector has no reply-keyboard support** — `sendActions` builds `reply_markup.inline_keyboard` only (`telegram-vendor.connector.ts:355-368`). Inline taps today route as `callback_query` via `acknowledgeCallback` → `answerCallbackQuery` (`:374-382`).

### cue-api touch-points

- **Add a reply-keyboard variant to `sendMessage`/`sendActions`** (or a new `setKeyboard` method) emitting `reply_markup: { keyboard, is_persistent: true, resize_keyboard: true }`.
- **Routing**: register text-equality handlers for each label — `Today`, `Next week`, `Settings`, `Disconnect`, `Back`. The keyboard swap (`Settings` → `[Disconnect][Back]`, `Back` → main) is just "reply with a new message carrying the other keyboard."
- **ASCII/TUI calendar**: a pure renderer (no Telegram dependency) producing a monospace month/week grid, sent inside a ` ``` ` code block for fixed-width rendering. Day data comes from `TaskService.findOccurrencesInRange`.
- **"Latest button-result as recent context"**: store only the **latest** label result in a Redis key `assistant:lastButton:{userId}` (overwrite, not append) and inject it into the **volatile messages tail** of the next turn (never the cached prefix — ADR-0004).

### Risks

- **Label/text ambiguity** (facts): a user typing "Settings" is indistinguishable from the button. Acceptable for navigation labels, but if a label could be a real task title ("Today") the handler must be careful (e.g., only treat it as a command when the keyboard is the active surface).
- **Reply keyboard vs. the existing inline-button flows** (conflict confirm, ask_user) coexist — reply keyboard is navigation chrome; inline keyboards remain for in-turn decisions. Keep them in separate code paths.
- ASCII calendar width on narrow mobile clients — keep to ≤ ~30 chars/line and test on iOS/Android.

### Recommended approach

Add persistent-reply-keyboard support to the connector (`is_persistent`, `resize_keyboard`), route the five labels by text-equality, and swap keyboards by sending a new message. Render the calendar as a monospace code-block TUI from `findOccurrencesInRange`. Store **only the latest** button result in Redis and inject it into the next turn's volatile tail. No new entity required.

---

## F. Per-day notification reports (scheduler → AI summary → delivery; configured via management UI)

### Verified facts

- **`@nestjs/schedule` is registered but has zero `@Cron`/`@Interval` usages**; BullMQ is the live scheduler (`app.module.ts:6,33`; `webhook.consumer.ts:45`). BullMQ **repeatable/cron jobs are not yet used.**
- **No delivery worker exists.** `ScheduledNotification` is a schema-only outbox (PENDING/SENT/FAILED/CANCELLED, composite `status/fireAt` index); `ScheduledNotificationService` is a skeleton with no send logic (`scheduled-notification.service.ts`). APNs and Telegram send paths are unimplemented.
- **`User.timezone` (IANA, default UTC) exists** (`user.entity.ts:41`) and `luxon` is used throughout for tz arithmetic — so "each day at a user-chosen local time" is computable, but **per-user-timezone cron is non-trivial** (a single global `@Cron` fires once; you must iterate opted-in users whose local HH:MM == now, or maintain per-user repeatable jobs).
- **There is NO web management UI in this repo or any sibling** — the only browser surface is Swagger at `/docs` (`main.ts:21,35`). The only non-iOS client is `cue-ios`. A "management UI (NOT via Telegram)" therefore means **either new iOS settings screens consuming new REST endpoints, or a brand-new web admin repo** (Decision 7).
- **No `UserSettings`/`UserPreferences` entity exists** — `User` has no preference columns; `UserMemoryFact` is the only per-user AI store and is not a settings table.

### cue-api touch-points

- **New entity** (`UserReportSettings`, or columns on `User`): `reportEnabled`, `reportTimeLocal`, `reportChannel`, `reportPromptOverride` (nullable; default prompt in code). New migration (`{unixMs}-…ts`, hand-written SQL, per CLAUDE.md ordering).
- **New REST**: `GET`/`PATCH /users/me/report-settings` behind `AccessTokenGuard`. Update `docs/api/openapi.yaml` in the same PR.
- **Scheduler**: a `@Cron('* * * * *')` (or `'0 * * * *'`) job querying opted-in users whose `User.timezone` local time matches now (luxon), building the day's report, sending it to the AI as **one request / one response** (reuse `complete`, BACKGROUND or main model), and delivering via the **outbox** (which must be implemented first) or directly via the Telegram connector.
- **New env vars** for cron schedule / lookahead must be added to the Zod schema (no optionals), `infra/production/ssm.tf`, and `.env.example` simultaneously.

### Risks

- **Delivery is a prerequisite.** The report feature is blocked on wiring `ScheduledNotification` delivery (or sending directly through the Telegram connector) — that work must land first.
- **Per-user-tz scheduling cost** at scale: a per-minute global scan is simplest and cheap at current user counts; per-user repeatable jobs are operationally heavier.
- **"Management UI"** has no home today (Decision 7) — the per-user custom prompt + time + channel need a settings surface that does not yet exist.
- Single global `@Cron` + DB scan must be idempotent (don't double-send if a deploy restarts mid-minute) — guard with a per-user "last sent date" check.

### Recommended approach

Add a `UserReportSettings` entity + `GET/PATCH /users/me/report-settings`, a per-minute `@nestjs/schedule` job that scans opted-in users by local time and enqueues a BullMQ "build-and-send report" job (one AI request/response, default prompt overridable per-user), delivered via the Telegram connector directly (and via the outbox once delivery is wired). **Surface the config in the iOS client** (new settings screens consuming the REST endpoints) rather than standing up a web admin repo — the brief says "NOT via Telegram," which iOS satisfies, and the iOS app is the existing owner of user settings (Decision 7).

---

## G. Per-user AI personality (persona string per session; default + seeded "Jarvis"; ADR-0004 caching consequence)

### Verified facts

- **The persona is a single shared compile-time constant today.** `ASSISTANT_SYSTEM_PROMPT` (the J.A.R.V.I.S. text) lives in `assistant.prompts.ts:13-40` and is injected as **system block 1 with `cacheBoundary: true`** (`context-builder.service.ts:270-285`) — **byte-identical for every user**, the multi-tenant shared prefix all users hit every turn.
- **[ADR-0004](../adr/0004-assistant-prompt-composition-and-caching.md) mandates block 1 carry no per-user/per-turn data.** Breakpoint #1 closes after the system prompt (and is intended to cover tool defs); breakpoint #2 closes after the rolling summary (`context-builder.service.ts:284`). Moving persona into block 1 **destroys the cross-user cache hit** — every user cold-starts the persona + tool defs every turn.
- **A safe per-user stable region exists between breakpoints #1 and #2** — the profile/groups blocks (`context-builder.service.ts:259-285`). A per-user persona placed there is cached by breakpoint #2 and stays warm until the summary is rewritten.
- ⚠️ **Latent cost bug surfaced by recon**: `tool-schemas.ts:238` comments that the last tool schema "carries `cacheBoundary`," but **no `ToolSchema` actually sets `cacheBoundary: true`**, so `AnthropicAiConnector.buildTools()` never applies `cache_control` to tools — tool defs may be paid full-price every turn. Worth fixing alongside G (not a blocker).

### cue-api touch-points

- **New `PersonaPrompt` entity** (`userId` FK, `promptText`, `source` enum, `updatedAt`) + repo + DatabaseService + migration; **seed a "Jarvis" default row** (or keep the default as a code constant and only persist overrides).
- **`ContextBuilderService.build()`**: fetch the active persona and insert it as a **new `PromptBlock` between the profile/groups blocks and the summary block, with NO `cacheBoundary`** — so it sits inside the per-user stable region closed by breakpoint #2. **Do not touch block 1.**
- **New REST**: `GET/PATCH /users/me/persona-settings` (pick a seeded persona or write your own) — same iOS-settings home as feature F (Decision 7).

### Risks

- **Cache regression if done naively.** The whole point of ADR-0004 is that block 1 is shared; the persona must go below breakpoint #1. Done correctly the damage is minimal (block 1 + tool defs stay shared; persona joins the already-per-user breakpoint-#2 region).
- **No persona enum in `UserMemoryFactType`** today — a `PersonaPrompt` entity with explicit semantics is cleaner than overloading `preference`/`other`.
- **Default vs. seeded row** — a code-constant default avoids a seed migration but a DB-seeded "Jarvis" row lets users browse/pick presets (mild trade-off, engineer's call).

### Recommended approach

Add a `PersonaPrompt` entity, default to the existing Jarvis text (seeded as a pickable preset), and inject the per-user persona as a **non-cache-boundary block between the profile and summary blocks** so [ADR-0004](../adr/0004-assistant-prompt-composition-and-caching.md)'s shared block-1 prefix is preserved. Expose selection/custom-text via iOS settings REST. Opportunistically fix the stale tool-schema `cacheBoundary` so tool defs are actually cached.

---

## Cross-cutting dependencies & sequencing

1. **Messenger-port extension (A)** — `editMessageText`, `sendChatAction`, `deleteMessage`, `sendMessageDraft`, reply-keyboard — is the **foundation** for A, C, and E. Do it first.
2. **`ask_user` per ADR-0010** unblocks **D** (and is reusable by B's mid-processing questions). It is the largest single new subsystem (new entity + resume + cleanup job).
3. **Delivery worker** for `ScheduledNotification` is a prerequisite for **F**.
4. **Per-user serialization lock** (a per-user advisory lock / Redis mutex) is shared by **B** (queue-after) and **D/0010** (double-resume race) — build once.
5. **AI streaming (`completeStream`)** is additive and independent; the context-editing-beta-stream combination needs a one-line SDK check first.

## Decisions for the product owner

The structured output carries the full decisions list with options and recommendations. In brief: (1) reconcile the 25 ms animation against real Telegram limits; (2) plain vs. rich streaming drafts; (3) WAIT-window coalescing — combine vs. last-wins; (4) STOP — keep partial writes vs. roll back; (5) AI-judged-conflict safety posture & whether "conflicts OK" is durable vs. per-message; (6) management-UI home for F/G (iOS vs. new web admin); (7) plain `sendMessageDraft` rollout gating (private-chat-only, client-version coverage).

## Open risks / unknowns

See the workflow output's `openRisks`. The load-bearing unknowns: draft-call throttling is **undocumented**; streaming + context-editing-beta is **unverified** in the installed SDK; per-user-timezone cron and the missing delivery worker block F; AI-judged conflicts move a safety gate from deterministic to model-judged; raising BullMQ `attempts` above 1 changes STOP/redrive/status idempotency assumptions.
