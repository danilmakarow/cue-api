# AI assistant — Task 2: AI connector

- **Status**: Draft (design pending sign-off — the spec is still Draft)
- **Owner**: @danil
- **Build order**: 2 of 3 — [External vendor](./ai-assistant-1-external-vendor-connector.md) → AI → [Application wiring](./ai-assistant-3-application-wiring.md)
- **Design**: [telegram-ai-assistant spec](../specs/telegram-ai-assistant.md) · ADRs [0003](../adr/0003-assistant-llm-provider-anthropic.md) · [0004](../adr/0004-assistant-prompt-composition-and-caching.md) · [0005](../adr/0005-assistant-conversation-memory-model.md) · [0007 — provider-connector-abstraction](../adr/0007-provider-connector-abstraction.md)

## Story

As a Cue backend engineer, I want LLM access behind a provider-agnostic AI connector with an Anthropic implementation, so that the assistant can run tool-using turns and cheap background jobs on Claude today and swap or add providers later without changing orchestration code.

## Context / Why now

[ADR 0003](../adr/0003-assistant-llm-provider-anthropic.md) picks Anthropic (Claude Sonnet for the main reasoning turn, Haiku for background jobs) but explicitly wants conversation state to stay **vendor-independent**. [ADR 0004](../adr/0004-assistant-prompt-composition-and-caching.md) needs developer-controlled prompt caching with two cache breakpoints; [ADR 0005](../adr/0005-assistant-conversation-memory-model.md) needs cheap **structured** background calls (summary, fact extraction). A thin connector that expresses these capabilities generically keeps the single-provider risk contained.

## Acceptance Criteria

- [ ] An abstract `AiConnector` contract defines a single `complete(request)` round-trip accepting ordered prompt blocks, tool schemas, a model role, and feature flags, returning a normalized `CompletionResult` (final text and/or tool calls, stop reason, token usage).
- [ ] Prompt blocks carry an optional `cacheBoundary` marker; the contract lets callers place **≥2 breakpoints** ([ADR 0004](../adr/0004-assistant-prompt-composition-and-caching.md)) without knowing provider cache mechanics.
- [ ] A model-role abstraction (`MAIN | BACKGROUND`) maps to configured model ids — **no model string is hardcoded** in the connector or its callers ([ADR 0003](../adr/0003-assistant-llm-provider-anthropic.md)).
- [ ] A typed `completeStructured<T>(request, schema)` helper supports background JSON jobs (rolling summary, memory-fact extraction, query-aware date parse) and validates the result against the schema.
- [ ] Token usage (input, output, cache-read, cache-write) is returned so callers can persist `tokenCount` and build a cost/cache-hit view.
- [ ] Capability flags (`promptCaching`, `contextEditing`, `structuredOutput`) are declared; an unsupported feature degrades to a no-op, never an error.
- [ ] An `AiConnectorFactory` resolves the active provider from config (`ASSISTANT_AI_PROVIDER`); an unknown/unconfigured provider **fails fast at startup**.
- [ ] `AnthropicAiConnector` implements the contract over `@anthropic-ai/sdk`: maps blocks→`system` + `messages` with `cache_control: { type: 'ephemeral' }` at marked breakpoints, maps tool schemas→`tools`, surfaces `tool_use`→normalized tool calls, returns `usage` including cache tokens, and sets the `context-management` beta header when that feature is enabled.
- [ ] Given a 429 / 5xx from the provider, when `complete` is called, then it retries with bounded backoff and surfaces a typed `AiUnavailableError` on exhaustion — never a raw SDK error to callers.
- [ ] **Boundary respected:** the connector performs exactly one model round-trip; the multi-step tool loop, tool dispatch, and the 5-fetch cap live in the orchestrator ([Task 3](./ai-assistant-3-application-wiring.md) / [ADR 0006](../adr/0006-assistant-schedule-context-and-conflicts.md)).
- [ ] Repo conventions: abstract class with real methods, enums in-file + re-exported, no `any`, JSDoc, Zod-validated config.

## Out of scope

- Prompt-block **assembly and ordering** — that's `ContextBuilderService` ([Task 3](./ai-assistant-3-application-wiring.md), [ADR 0004](../adr/0004-assistant-prompt-composition-and-caching.md)). The connector consumes already-ordered blocks and only applies cache markers.
- Tool **dispatch** into feature services, the fetch cap, and conflict holds — orchestrator ([Task 3](./ai-assistant-3-application-wiring.md), [ADR 0006](../adr/0006-assistant-schedule-context-and-conflicts.md)).
- Conversation memory tiers and persistence ([ADR 0005](../adr/0005-assistant-conversation-memory-model.md), [Task 3](./ai-assistant-3-application-wiring.md)).
- Speech-to-text and embeddings / semantic recall ([spec open questions](../specs/telegram-ai-assistant.md#open-questions)).
- Streaming responses — v1 sends a single reply; revisit if latency demands it.

## Technical notes

**Location.** New top-level module `src/modules/ai/`, promoted out of the assistant's inline `llm/` folder for reusability/swappability — **refines** the [spec module layout](../specs/telegram-ai-assistant.md#module-layout).

**Structure** (the [ADR 0007](../adr/0007-provider-connector-abstraction.md) pattern, symmetric with the [external-vendor connector](./ai-assistant-1-external-vendor-connector.md) — same base + config + factory + impl shape):

```
src/modules/ai/
  ai.types.ts                 ← enums + normalized request/result DTOs
  ai-connector.abstract.ts
  ai.config.ts                ← typed config from env
  ai-connector.factory.ts
  anthropic/
    anthropic-ai.connector.ts ← concrete @anthropic-ai/sdk impl
  ai.module.ts                ← registers connectors + factory; exports factory + an ACTIVE_AI_CONNECTOR token
```

**The contract** (illustrative sketch):

```ts
export abstract class AiConnector {
  abstract readonly provider: AiProvider;
  abstract readonly capabilities: AiCapabilities;

  /** One model round-trip. Returns final text and/or tool calls + token usage. */
  abstract complete(request: CompletionRequest): Promise<CompletionResult>;

  /** Background helper: force a JSON result and validate it against `schema`. */
  abstract completeStructured<TResult>(
    request: CompletionRequest,
    schema: ZodType<TResult>,
  ): Promise<TResult>;
}
```

**Data shapes** (`ai.types.ts`): `AiProvider` enum (`ANTHROPIC`); `AiModelRole` enum (`MAIN | BACKGROUND`); `PromptBlock { role, content, cacheBoundary?: boolean }`; `ToolSchema { name, description, inputSchema }`; `ToolCall { id, name, input }`; `ToolResultBlock { toolCallId, content, isError? }`; `ToolRound { toolCalls: ToolCall[], toolResults: ToolResultBlock[], assistantText? }`; `CompletionRequest { modelRole, system?: PromptBlock[], messages: PromptBlock[], tools?: ToolSchema[], toolRounds?: ToolRound[], maxTokens, features?: { promptCaching?: boolean; contextEditing?: boolean } }`; `CompletionResult { stopReason, text?, toolCalls?: ToolCall[], usage: AiUsage }`; `AiUsage { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }`; `AiCapabilities { promptCaching, contextEditing, structuredOutput }`.

**Multi-round tool turns.** A multi-step tool loop (model emits `tool_use` → orchestrator dispatches → calls `complete` again so the model can continue) requires each prior round to be replayed in the request, because the provider's Messages API rejects a `tool_result` that isn't preceded by an assistant turn carrying the matching `tool_use`. These rounds ride back through `CompletionRequest.toolRounds` in the already-normalized `ToolCall[]` / `ToolResultBlock[]` shapes — **vendor turn-structure never crosses the boundary** (ADR 0007). The connector renders each round as an `assistant` (`assistantText?` + `tool_use` blocks) turn followed by a `user` (`tool_result` blocks) turn, positioned after `messages` (the volatile tail, below the [ADR 0004](../adr/0004-assistant-prompt-composition-and-caching.md) cache breakpoints, so the cached prefix stays byte-stable). Each `tool_result.tool_use_id` pairs to its originating `ToolCall.id`. The **connector stays stateless** — it holds no cross-call turn state (it is a shared singleton); the orchestrator owns the conversation history and appends each completed round.

**Caching.** Blocks flagged `cacheBoundary: true` get Anthropic `cache_control: { type: 'ephemeral' }` on that content block. [ADR 0004](../adr/0004-assistant-prompt-composition-and-caching.md) places the two breakpoints after the tool definitions and after the per-user profile+summary; the connector stays agnostic to *which* blocks — the caller marks them.

**Model routing.** Role→id via `ASSISTANT_MODEL_MAIN` / `ASSISTANT_MODEL_BACKGROUND`. `completeStructured` defaults to `BACKGROUND`. This realizes the [ADR 0003](../adr/0003-assistant-llm-provider-anthropic.md) two-model split provider-agnostically.

**Context editing.** When `features.contextEditing` is set, add the `context-management-2025-06-27` beta header and the `clear_tool_uses` config (tool-result hygiene, [spec](../specs/telegram-ai-assistant.md#the-three-memory-mechanisms)); no-op for providers lacking it.

**Retry.** Shared bounded backoff in the base class (or a small shared helper) on 429/5xx; typed `AiUnavailableError` on exhaustion → the orchestrator maps it to the spec's "having trouble right now" reply.

**Configuration** (Zod → `ConfigService`, added in [Task 3](./ai-assistant-3-application-wiring.md)): `ASSISTANT_AI_PROVIDER` (enum, default `anthropic`), `ANTHROPIC_API_KEY`, `ASSISTANT_MODEL_MAIN`, `ASSISTANT_MODEL_BACKGROUND`, optional `ASSISTANT_MAX_OUTPUT_TOKENS`.

## Dependencies / Risks

- Independent of [Task 1](./ai-assistant-1-external-vendor-connector.md); a **prerequisite for [Task 3](./ai-assistant-3-application-wiring.md)**.
- New dependency `@anthropic-ai/sdk`; needs `ANTHROPIC_API_KEY` provisioned.
- **Risk — model pinning.** Pin specific Claude versions vs track a "latest" alias is a [spec open question](../specs/telegram-ai-assistant.md#open-questions); keeping ids in env lets ops pin without a redeploy.
- **Risk — caching depends on byte-stable blocks.** The connector can't enforce prefix stability; the caller must ([ADR 0004](../adr/0004-assistant-prompt-composition-and-caching.md)). Called out again in [Task 3](./ai-assistant-3-application-wiring.md).
- **Risk — structured-output reliability** varies by provider; validate with the Zod schema and retry once on a parse failure before surfacing an error.

> Definition of Ready & Definition of Done: see team wiki.
