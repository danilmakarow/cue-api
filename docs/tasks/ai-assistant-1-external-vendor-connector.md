# AI assistant — Task 1: External vendor connector

- **Status**: Draft (design pending sign-off — the spec is still Draft)
- **Owner**: @danil
- **Build order**: 1 of 3 — External vendor → [AI](./ai-assistant-2-ai-connector.md) → [Application wiring](./ai-assistant-3-application-wiring.md)
- **Design**: [telegram-ai-assistant spec](../specs/telegram-ai-assistant.md) · ADRs [0003](../adr/0003-assistant-llm-provider-anthropic.md) · [0007 — provider-connector-abstraction](../adr/0007-provider-connector-abstraction.md)

## Story

As a Cue backend engineer, I want inbound and outbound messaging behind a vendor-agnostic connector with a Telegram implementation, so that the assistant can receive and reply to messages over Telegram today and adopt new messaging vendors later without touching orchestration code.

## Context / Why now

The assistant ([spec](../specs/telegram-ai-assistant.md)) needs a transport to receive a user's messages and send replies; Telegram is the v1 channel ([ADR 0003](../adr/0003-assistant-llm-provider-anthropic.md) picks the *AI*, not the transport). We deliberately abstract the messaging vendor so the orchestrator depends on a normalized message contract rather than Telegram payload shapes — adding WhatsApp/iMessage/etc. later becomes a new implementation, not a rewrite. Telegram is integrated via **webhooks** (push), not long-polling.

## Acceptance Criteria

- [ ] Given the connector package, when reviewed, then an abstract `ExternalVendorConnector` contract defines: webhook authentication (`acceptWebhook`) and deferred parse+normalize of a queued job (`handleWebhook`), dedupe-id extraction, media fetch, outbound text, outbound action buttons, callback acknowledgement, webhook register/remove, and a declared `capabilities` set.
- [ ] A `NormalizedInboundMessage` type represents `text`, `voice` (with a fetchable media ref), `command` (name + args), and `callback` (button tap) kinds — independent of any vendor's wire format.
- [ ] An `ExternalVendorConnectorFactory` resolves the active connector from config (`EXTERNAL_VENDOR`) and exposes both `getActive()` and `get(vendor)`; an unknown or unconfigured vendor **fails fast at startup**, not at first request.
- [ ] `TelegramVendorConnector` implements the contract over the Telegram Bot API in webhook mode: parses an `Update`, exposes `update_id` as the dedupe id, sends messages and inline keyboards, answers callback queries, and resolves a voice note to downloadable bytes via `getFile`.
- [ ] Given a webhook request whose `X-Telegram-Bot-Api-Secret-Token` header does not match config, when it is received, then `acceptWebhook` returns false (or throws), the request is rejected, and **nothing is enqueued**.
- [ ] `acceptWebhook` performs **authentication only** — no parsing, no I/O, no side effects — so the controller can call it and return `200` immediately; `handleWebhook` performs the deferred parse+normalize from a queued `WebhookJob` (`{ vendor, ip, headers, body }`) in the consumer. The connector does **not** own the queue (that is [Task 3](./ai-assistant-3-application-wiring.md)).
- [ ] Given a Telegram voice note, when normalized, then the message carries a media reference that `fetchMedia` resolves to `{ bytes, mimeType }` (transcription itself is out of scope — see below).
- [ ] Capability flags (`supportsVoice`, `supportsInlineButtons`, `supportsCallbacks`) are declared per vendor so callers can degrade gracefully instead of assuming Telegram features everywhere.
- [ ] Every outbound call returns a `VendorMessageRef` (vendor message id) the caller can persist for tracing/dedupe.
- [ ] Code follows repo conventions: abstract class with real (non-arrow) methods, enums declared in their own file and re-exported, no `any`, JSDoc on new functions, config read via Zod-validated `ConfigService`.

## Out of scope

- Orchestration, the LLM/tool loop, and conversation persistence — [Task 3](./ai-assistant-3-application-wiring.md) + [spec](../specs/telegram-ai-assistant.md).
- **Speech-to-text.** The connector only retrieves the audio bytes; transcription is its own connector — [Task 4](./ai-assistant-4-stt-connector.md) (OpenAI), consumed by [Task 3](./ai-assistant-3-application-wiring.md).
- Outbound reminder delivery ([notification-delivery spec](../specs/notification-delivery.md)) — though that path should later reuse this connector's egress (see Risks).
- Group chats, polling mode, and TTS/voice replies — [spec non-goals](../specs/telegram-ai-assistant.md).
- *Calling* `registerWebhook` at deploy time is implemented here but *invoked/scheduled* in [Task 3](./ai-assistant-3-application-wiring.md).
- The **webhook queue, controller, and consumer** that bundle `{ ip, headers, body, vendor }` into a job and invoke `handleWebhook` later — that wiring is [Task 3](./ai-assistant-3-application-wiring.md). This task only defines `acceptWebhook` / `handleWebhook`.

## Technical notes

**Location.** New top-level module `src/modules/external-vendor/`, promoted out of the assistant module so it is reusable and swappable. This **refines** the inline `telegram.client.ts` in the [spec module layout](../specs/telegram-ai-assistant.md#module-layout).

**Structure** (the provider-connector pattern from [ADR 0007](../adr/0007-provider-connector-abstraction.md); no existing factory pattern in-repo yet, so this establishes it):

```
src/modules/external-vendor/
  external-vendor.types.ts            ← enums + normalized DTOs (see below)
  external-vendor-connector.abstract.ts
  external-vendor.config.ts           ← typed per-vendor config from env
  external-vendor-connector.factory.ts
  telegram/
    telegram-vendor.connector.ts      ← concrete Telegram impl (webhook mode)
  external-vendor.module.ts           ← registers connectors + factory; exports the factory + an ACTIVE_VENDOR_CONNECTOR token
```

**The contract** (illustrative sketch — real methods, repo style):

```ts
export abstract class ExternalVendorConnector {
  abstract readonly vendor: ExternalVendor;
  abstract readonly capabilities: VendorCapabilities;

  /**
   * Authenticate an inbound webhook (secret token / signature / source IP) — the ONLY
   * work done before the controller returns 200. Return true to accept, false or throw
   * to reject. Must not parse, persist, or call out: it runs in the request path.
   */
  abstract acceptWebhook(request: WebhookRequest): boolean | Promise<boolean>;
  /**
   * Parse + normalize a previously-accepted webhook job (pulled from the queue) into
   * Cue's domain message; null = ignore. Runs in the consumer, never the request path.
   */
  abstract handleWebhook(job: WebhookJob): Promise<NormalizedInboundMessage | null>;
  /** Download media (e.g. a voice note) referenced by a normalized message. */
  abstract fetchMedia(ref: MediaRef): Promise<MediaPayload>;
  /** Send a plain text message; returns the vendor message reference. */
  abstract sendMessage(chatId: string, text: string): Promise<VendorMessageRef>;
  /** Send text plus inline action buttons (confirm / pick another / cancel). */
  abstract sendActions(
    chatId: string,
    text: string,
    actions: OutboundAction[],
  ): Promise<VendorMessageRef>;
  /** Acknowledge a button tap so the client stops its spinner. */
  abstract acknowledgeCallback(callbackId: string, note?: string): Promise<void>;
  /** Register / remove the push webhook with the vendor. */
  abstract registerWebhook(url: string, secret: string): Promise<void>;
  abstract removeWebhook(): Promise<void>;
}
```

**Data shapes** (`external-vendor.types.ts`): `ExternalVendor` enum (`TELEGRAM`); `InboundKind` enum (`TEXT | VOICE | COMMAND | CALLBACK`); `NormalizedInboundMessage { vendor, kind, chatId, vendorMessageId, dedupeId, text?, command?: { name, args }, callback?: { id, data }, media?: MediaRef, username? }`; `OutboundAction { id, label, data }`; `VendorMessageRef { vendorMessageId }`; `MediaPayload { bytes: Buffer, mimeType: string }`; `VendorCapabilities { supportsVoice, supportsInlineButtons, supportsCallbacks }`. Webhook ingress adds `WebhookRequest { ip, headers, body }` (the `acceptWebhook` input, request-path) and `WebhookJob { vendor, ip, headers, body, receivedAt }` (what the wrapper enqueues for `handleWebhook`).

**Configuration** (Zod → `ConfigService`, added in [Task 3](./ai-assistant-3-application-wiring.md)): `EXTERNAL_VENDOR` (enum, default `telegram`), `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, optional `TELEGRAM_API_BASE`.

**Factory.** A Nest provider that, given `EXTERNAL_VENDOR`, returns the matching registered connector; also bind an `ACTIVE_VENDOR_CONNECTOR` token via `useFactory` so most consumers inject the active connector directly while `get(vendor)` stays available for a future multi-vendor world.

**Telegram specifics.**
- Webhook mode via `setWebhook` with `secret_token`. `acceptWebhook` constant-time compares the `X-Telegram-Bot-Api-Secret-Token` header to `TELEGRAM_WEBHOOK_SECRET` (model the config-compare on [`DevOnlyGuard`](../../src/common/guards/dev-only.guard.ts)) and does nothing else; `handleWebhook` parses the queued `Update` into a `NormalizedInboundMessage`.
- Outbound: `sendMessage`, `editMessageReplyMarkup`, `answerCallbackQuery`; inline keyboards back the [Safety / confirmations](../specs/telegram-ai-assistant.md#safety--confirmations) and the [ADR 0006](../adr/0006-assistant-schedule-context-and-conflicts.md) layer-4 conflict prompt.
- Voice: `getFile` → `https://api.telegram.org/file/bot<token>/<path>` to download OGG/Opus bytes.
- `update_id` is the dedupe id (the Redis dedupe **set** lives in [Task 3](./ai-assistant-3-application-wiring.md)); `chatId` maps to the existing [`TelegramLink.telegramChatId`](../../src/modules/database/entities/telegram-link.entity.ts) (bigint-as-string).

**HTTP client.** Telegram has no official SDK. Prefer Node 20's global `fetch` (no new dep) or the already-named `node-telegram-bot-api` in **webhook-only** mode (no polling) per [repo CLAUDE.md]. Picking `fetch` aligns with the project's "vendor/own over new deps" preference — small decision to confirm at build time.

## Dependencies / Risks

- Independent of [Task 2](./ai-assistant-2-ai-connector.md); a **prerequisite for [Task 3](./ai-assistant-3-application-wiring.md)**.
- Needs a `TELEGRAM_BOT_TOKEN` from @BotFather and a public HTTPS webhook URL. Local dev is already covered by the repo's `dev-ngrok` script (`ngrok http --domain cue.ngrok.app 3067`).
- **Risk — two Telegram clients.** `NotificationChannel.TELEGRAM` and the [notification-delivery](../specs/notification-delivery.md) "Telegram sender" already imply outbound Telegram. This connector should become the **single** Telegram egress; the notification path should consume `ExternalVendorModule` rather than build a second client. Coordinate before both land.
- **Risk — client choice.** `fetch` vs `node-telegram-bot-api`; keep it webhook-only either way so we never accidentally enable polling alongside the webhook.
- `TELEGRAM_WEBHOOK_SECRET` must be a strong random value and rotatable via env.

> Definition of Ready & Definition of Done: see team wiki.
