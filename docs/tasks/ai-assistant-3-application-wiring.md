# AI assistant — Task 3: Application wiring

- **Status**: Draft (design pending sign-off — the spec is still Draft)
- **Owner**: @danil
- **Build order**: 3 of 3 — [External vendor](./ai-assistant-1-external-vendor-connector.md) → [AI](./ai-assistant-2-ai-connector.md) → Application wiring
- **Design**: [telegram-ai-assistant spec](../specs/telegram-ai-assistant.md) · ADRs [0004](../adr/0004-assistant-prompt-composition-and-caching.md) · [0005](../adr/0005-assistant-conversation-memory-model.md) · [0006](../adr/0006-assistant-schedule-context-and-conflicts.md) · [0007](../adr/0007-provider-connector-abstraction.md)

## Story

As a Cue user, I want to link my Telegram account once and then manage my calendar by chatting in natural language (text or voice), so that I have an always-available scheduling assistant backed by my real calendar data.

## Context / Why now

[Tasks 1](./ai-assistant-1-external-vendor-connector.md) and [2](./ai-assistant-2-ai-connector.md) deliver the transport and AI connectors. This task assembles them into the `assistant` module described in the [spec](../specs/telegram-ai-assistant.md): the conversation/memory persistence ([ADR 0005](../adr/0005-assistant-conversation-memory-model.md)), the prompt assembly + caching ([ADR 0004](../adr/0004-assistant-prompt-composition-and-caching.md)), the schedule-context + conflict logic ([ADR 0006](../adr/0006-assistant-schedule-context-and-conflicts.md)), the two endpoints, Redis as its first consumer, env validation, and the migration.

## Acceptance Criteria

**Persistence / data model**

- [ ] New entities `Conversation`, `ConversationMessage`, `ConversationSummary`, `UserMemoryFact` are added in the strict order entity → repository → DatabaseService → register in `DatabaseModule`, with enums (`ConversationMessageRole`, `ConversationMessageContentType`, `UserMemoryFactType`, `UserMemoryFactSource`) declared in-file and re-exported from `entities/index.ts`.
- [ ] A **reversible** raw-SQL migration creates the four tables + enum types + FKs + indexes (UUID PKs, `timestamptz`), cascading from `User`/`Conversation` per the [spec data model](../specs/telegram-ai-assistant.md#data-model); no `synchronize`.
- [ ] [`architecture.md`](../architecture.md) domain model + module layout reflect the new entities and modules.

**Endpoints / transport**

- [ ] `POST /assistant/telegram/webhook` exists and is **not** JWT-guarded. It authenticates via the active vendor connector's `acceptWebhook`; on accept it **enqueues** a `WebhookJob` `{ vendor, ip, headers, body, receivedAt }` and returns `200` **immediately**; on reject it returns `4xx` and enqueues nothing.
- [ ] The webhook is processed **off the request path**: a **durable** (Redis/BullMQ) queue holds accepted jobs and a **consumer** pulls each one, calls `connector.handleWebhook`, resolves the user, and runs the pipeline.
- [ ] Because a `200` tells Telegram the update is delivered — it will **not** redeliver — the queue must be durable: a crash between the `200` and processing must not lose the update; the job survives a restart and is retried.
- [ ] Given a duplicate Telegram `update_id`, when received, then it is de-duplicated (the dedupe id is the queue **job id**, backed by a Redis guard) so the pipeline runs at most once per update.
- [ ] A job whose processing throws is retried with backoff; after the max attempts it is dead-lettered and logged — never silently dropped.
- [ ] `POST /assistant/link` exists, **JWT-guarded** ([`AccessTokenGuard`](../../src/common/guards/access-token.guard.ts)), body `{ code }`; validates and burns a Redis nonce and upserts `TelegramLink` (reusing [`TelegramLinkDatabaseService`](../../src/modules/database/services/telegram-link-database.service.ts)).
- [ ] [`api/openapi.yaml`](../api/openapi.yaml) is updated with both endpoints in the same change.
- [ ] Given an inbound message from an **unlinked** chat, when received, then the bot replies with the linking prompt and does **not** call the LLM.

**Orchestration**

- [ ] The **consumer** runs the [spec inbound pipeline](../specs/telegram-ai-assistant.md#inbound-pipeline-every-telegram-update) for each dequeued job: `handleWebhook` (parse+normalize) → dedupe → resolve user → normalize voice via STT → persist the user turn → build context → `AiConnector.complete` tool loop → dispatch tools → reply via the vendor connector → async background jobs.
- [ ] The tool loop is hard-capped at **5 schedule fetches per user turn**; the 6th request is refused with a note and the model proceeds on the data in hand ([ADR 0006](../adr/0006-assistant-schedule-context-and-conflicts.md) layer 3).
- [ ] Calendar tools (`list_events`, `create_event`, `update_event`, `delete_event`, `find_free_slots`, `set_reminder`) dispatch **only** into existing feature services ([`TaskService`](../../src/modules/task/task.service.ts), `CalendarService`, …) — never repositories or entities directly.
- [ ] Context is assembled in the fixed block order with two cache breakpoints and the timestamp **below both** ([ADR 0004](../adr/0004-assistant-prompt-composition-and-caching.md)); the preloaded today+7d agenda and any query-aware slice sit in the volatile region ([ADR 0006](../adr/0006-assistant-schedule-context-and-conflicts.md) layers 1–2).
- [ ] Given a `create_event`/`update_event` that overlaps an existing event, when executed, then the write is **held** in Redis (short TTL) and the user is asked via inline keyboard; the model is **not** re-invoked; on confirm the backend writes deterministically ([ADR 0006](../adr/0006-assistant-schedule-context-and-conflicts.md) layer 4).
- [ ] Slash commands execute deterministically (no LLM) and append a **synthetic summary line** as a `ConversationMessage` ([spec Commands](../specs/telegram-ai-assistant.md#commands)).
- [ ] Given an under-specified or ambiguous request (missing date/time/duration, or "my meeting" matching several), when processed, then the assistant asks a concise clarifying question — free-text, or an inline-keyboard pick-list for a small finite set — instead of guessing, and the user's next message continues the same conversation ([spec Replies and clarifying questions](../specs/telegram-ai-assistant.md#replies-and-clarifying-questions)).
- [ ] After the reply is sent, background Haiku jobs run **without blocking** it: re-summarize when the live window crosses its threshold; extract/update memory facts ([ADR 0005](../adr/0005-assistant-conversation-memory-model.md)).

**Config / infra**

- [ ] Redis is consumed for the first time — the **webhook ingestion queue (BullMQ)**, dedupe set, link nonces, held-conflict writes, optional latest-summary cache — and Redis vars are added to the Zod schema.
- [ ] All new env vars are validated in [`env.config.ts`](../../src/config/env.config.ts): `ASSISTANT_AI_PROVIDER`, `ANTHROPIC_API_KEY`, `ASSISTANT_MODEL_MAIN`, `ASSISTANT_MODEL_BACKGROUND`, `EXTERNAL_VENDOR`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `ASSISTANT_PUBLIC_WEBHOOK_URL`, `REDIS_HOST`/`REDIS_PORT`, and the STT vars `STT_PROVIDER` / `OPENAI_API_KEY` / `STT_MODEL` (see [Task 4](./ai-assistant-4-stt-connector.md)).
- [ ] On boot/deploy, the webhook is registered with Telegram via the vendor connector's `registerWebhook` (skippable in dev so `dev-ngrok` works).

**Error handling** (mirrors the [spec error table](../specs/telegram-ai-assistant.md#error-handling))

- [ ] Crash between the `200` and processing → the job is durable in the queue and a worker retries it (no lost update).
- [ ] STT failure → "couldn't hear that" reply; no user turn persisted.
- [ ] LLM retries exhausted → "having trouble right now" reply; never a silent drop.
- [ ] Tool execution error → returned to the model as the tool result (no raw stack trace to the user).
- [ ] Held-conflict TTL expiry → discard the write; tell the user it was cancelled.
- [ ] Telegram send fails (chat blocked) → mark `TelegramLink` inactive (shared with notification-delivery), stop.

## Out of scope

- The connector internals — [Task 1](./ai-assistant-1-external-vendor-connector.md) + [Task 2](./ai-assistant-2-ai-connector.md).
- **The STT connector internals** — [Task 4](./ai-assistant-4-stt-connector.md) (OpenAI). This task **consumes** it: the consumer calls the active STT connector to turn voice bytes into a transcript, then feeds the text into the pipeline.
- Persona / prompt copy tuning — [spec Voice and persona](../specs/telegram-ai-assistant.md#voice-and-persona).
- The iOS "Connect Telegram?" screen + universal-link handler (cross-repo `cue-ios` spec).
- Semantic recall / pgvector — [spec deferred](../specs/telegram-ai-assistant.md#open-questions).
- Notification delivery itself ([separate spec](../specs/notification-delivery.md)) — only coordinate the shared `TelegramLink` egress + a possible `TelegramLink.isActive` flag.
- Moving the **post-turn background jobs** (summary, memory extraction) onto the queue — they may stay in-process for v1. Only the **webhook ingestion** path requires the durable queue; BullMQ is adopted here for ingestion and is shared with [notification-delivery](../specs/notification-delivery.md).

## Technical notes

**Module.** `src/modules/assistant/` per the [spec layout](../specs/telegram-ai-assistant.md#module-layout), **minus** the connector internals (now the `external-vendor` and `ai` modules). It imports `DatabaseModule`, the tool-target feature modules ([`TaskModule`](../../src/modules/task/task.module.ts), `CalendarModule`, `NotificationStrategyModule`), `ExternalVendorModule`, `AiModule`, `SttModule` ([Task 4](./ai-assistant-4-stt-connector.md)), and a new `RedisModule`.

**Components.** `assistant-webhook.controller.ts` (ingress: `acceptWebhook` → enqueue → `200`; + `/assistant/link`), `webhook.consumer.ts` (pulls jobs → `handleWebhook` → pipeline), `assistant.service.ts` (orchestrator), `context-builder.service.ts` ([ADR 0004](../adr/0004-assistant-prompt-composition-and-caching.md)), `tools/` (JSON schemas + dispatch), `background/summarizer.service.ts`, `background/memory-extractor.service.ts`, `commands/`.

**New entities — data shape** (follows [`BaseEntity`](../../src/modules/database/entities/base.entity.ts): UUID `id`, `createdAt`, `updatedAt`):

| Entity | Key fields |
|---|---|
| `Conversation` | `userId` (unique, 1:1 `User`, cascade), `lastActivityAt`, `latestSummaryId?` |
| `ConversationMessage` | `conversationId` (cascade), `role` enum (`user`/`assistant`/`tool`/`synthetic`), `contentType` enum (`text`/`voice_transcript`/`command_result`), `content` text, `toolPayload` jsonb?, `telegramMessageId` bigint-as-string?, `tokenCount` int? |
| `ConversationSummary` | `conversationId` (cascade), `summaryText`, `coversUpToMessageId`, `tokenCount` |
| `UserMemoryFact` | `userId` (cascade), `type` enum, `key`, `value` jsonb, `confidence` numeric, `source` enum (`inferred`/`explicit`) |

Files to touch for each: `entities/<name>.entity.ts` + `entities/index.ts`; `repositories/<name>.repository.ts` + `repositories/index.ts`; `services/<name>-database.service.ts` + `services/index.ts`; then register in [`database.module.ts`](../../src/modules/database/database.module.ts) providers + exports.

**Redis.** New `RedisModule` (one client; pick `ioredis` or `node-redis` — shared with the BullMQ webhook queue below). Keys: `assistant:dedupe:<update_id>` (short TTL), `assistant:link:<nonce>` (TTL 10m, single-use), `assistant:held:<callbackId>` (held write payload, TTL = the held-conflict open question). Add `REDIS_HOST`/`REDIS_PORT` (+ optional password/db) to the Zod schema — they exist in [`.env.example`](../../.env.example) but not yet in [`env.config.ts`](../../src/config/env.config.ts).

**Webhook ingestion queue.** The webhook splits into *accept* (request path) and *handle* (consumer):

1. **Controller** resolves the active vendor connector and calls `acceptWebhook({ ip, headers, body })`. Reject → `4xx`, stop. Accept → enqueue a `WebhookJob { vendor, ip, headers, body, receivedAt }` and return `200` immediately.
2. **Queue** is BullMQ on the existing Redis. The vendor dedupe id (`update_id`) is the **job id**, so duplicate deliveries collapse at the queue. Durability is the point: once we `200`, Telegram won't redeliver, so an in-memory queue would drop updates on a crash — BullMQ persists the job and retries on failure (backoff → dead-letter).
3. **Consumer** (`webhook.consumer.ts`) pulls a job, calls `connector.handleWebhook(job)` → `NormalizedInboundMessage`, then resolves the user and runs the pipeline.

BullMQ is pulled forward from a later phase here and is the same worker runtime [notification-delivery](../specs/notification-delivery.md) will use.

**Webhook auth.** Authentication is the connector's `acceptWebhook` (a thin `VendorWebhookGuard` may wrap it so the controller stays declarative). For Telegram that's a constant-time compare of `X-Telegram-Bot-Api-Secret-Token` to `TELEGRAM_WEBHOOK_SECRET` (model on [`DevOnlyGuard`](../../src/common/guards/dev-only.guard.ts)); Telegram authenticates via that header (not a body HMAC), so default JSON body parsing is fine — no raw-body middleware needed.

**Tools → services.** `create_event` → `TaskService.create` in the user's calendar; `list_events` → `TaskService.findInRange`; `update_event`/`delete_event` → the corresponding `TaskService` methods; `find_free_slots` → a read over `Task` in range. The **conflict check** (layer 4) is a server-side overlap query on `Task.startAt`/`endAt` before any write.

**Context builder.** Realizes the [ADR 0004](../adr/0004-assistant-prompt-composition-and-caching.md) order + breakpoints: profile from `UserMemoryFact`, summary from `ConversationSummary`, recent window from `ConversationMessage`, now+agenda from `Task` (via `TaskService`), query-aware slice via Luxon date parsing with a `AiConnector.completeStructured` Haiku fallback. Marks the two `cacheBoundary` blocks; keeps the timestamp out of the cached prefix.

**Webhook registration.** On boot, call `ExternalVendorConnectorFactory.getActive().registerWebhook(ASSISTANT_PUBLIC_WEBHOOK_URL + '/assistant/telegram/webhook', TELEGRAM_WEBHOOK_SECRET)` — guarded so a missing/dev URL doesn't crash local runs.

## Dependencies / Risks

- **Blocked by [Task 1](./ai-assistant-1-external-vendor-connector.md) + [Task 2](./ai-assistant-2-ai-connector.md).**
- Depends on auth — [`AccessTokenGuard`](../../src/common/guards/access-token.guard.ts) already exists — for `/assistant/link`. Depends on Redis (provisioned in `docker-compose.dev.yml`, newly consumed here).
- **Risk — cache savings depend on byte-stable blocks** ([ADR 0004](../adr/0004-assistant-prompt-composition-and-caching.md)); enforce in `context-builder` and add a hit-rate log.
- **Durable ingestion (resolved):** webhook jobs use BullMQ precisely because a post-`200` crash would otherwise lose the update; post-turn background jobs (summary/extraction) may still run in-process for v1.
- **Risk — undecided defaults:** held-conflict TTL and preloaded horizon are [spec open questions](../specs/telegram-ai-assistant.md#open-questions); pick env-tunable defaults (e.g. 10 min TTL, 7-day horizon).
- **STT (resolved):** provider is OpenAI via the STT connector ([Task 4](./ai-assistant-4-stt-connector.md)); note its OGG→WAV transcode (ffmpeg), since OpenAI doesn't accept Telegram's native format.
- **Risk — double Telegram egress** with notification-delivery; share the connector + a `TelegramLink.isActive` flag.

> Definition of Ready & Definition of Done: see team wiki.
