/**
 * Provider-agnostic types for the AI connector.
 *
 * These DTOs are the contract the assistant orchestrator (Task 3) speaks; no
 * vendor (Anthropic, etc.) payload shape leaks past this boundary. The concrete
 * connector translates to/from its SDK and back into these shapes.
 *
 * See docs/adr/0007-provider-connector-abstraction.md and
 * docs/tasks/ai-assistant-2-ai-connector.md.
 */

/**
 * Supported LLM providers. Only Anthropic exists today; the enum is the
 * discriminator the factory resolves from `ASSISTANT_AI_PROVIDER`.
 */
export enum AiProvider {
  ANTHROPIC = 'anthropic',
}

/**
 * Logical model role, mapped to a configured model id by the connector. Keeps
 * concrete model strings out of the connector and its callers — the
 * Sonnet-for-reasoning / Haiku-for-background split from ADR 0003 expressed
 * provider-agnostically.
 */
export enum AiModelRole {
  MAIN = 'main',
  BACKGROUND = 'background',
}

/**
 * Author of a prompt block, independent of any provider's role vocabulary.
 */
export enum PromptRole {
  USER = 'user',
  ASSISTANT = 'assistant',
}

/**
 * Why the model stopped generating, normalized across providers. `END_TURN` is
 * a final answer; `TOOL_USE` means the orchestrator must run the returned tool
 * calls and continue the turn (Task 3 owns that loop).
 */
export enum AiStopReason {
  END_TURN = 'end_turn',
  TOOL_USE = 'tool_use',
  MAX_TOKENS = 'max_tokens',
  STOP_SEQUENCE = 'stop_sequence',
  REFUSAL = 'refusal',
  OTHER = 'other',
}

/**
 * One ordered unit of conversation content. `cacheBoundary` asks the connector
 * to place a provider cache breakpoint after this block; the connector stays
 * agnostic to *which* block carries it — the caller (ContextBuilderService)
 * decides, per ADR 0004's two-breakpoint scheme.
 */
export interface PromptBlock {
  role: PromptRole;
  content: string;
  cacheBoundary?: boolean;
}

/**
 * A tool the model may call, described provider-neutrally. `inputSchema` is a
 * JSON Schema object describing the tool's arguments. `cacheBoundary` lets the
 * caller close the shared tool-definitions prefix (ADR 0004 breakpoint #1).
 */
export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  cacheBoundary?: boolean;
}

/**
 * Vendor-neutral tool-choice directive for one round-trip. `'auto'` lets the
 * model decide (the default — equivalent to omitting it); `'any'` forces it to
 * call some tool (no specific one); `{ name }` forces that exact tool. The
 * connector translates this to its provider's wire shape and DEGRADES to "let
 * the model decide" (never throws) when the request carries no tools — a forced
 * choice with nothing to choose from is meaningless, not an error.
 */
export type AiToolChoice = 'auto' | 'any' | { name: string };

/**
 * A model's request to invoke a tool. The orchestrator dispatches it and feeds
 * the outcome back as a `ToolResultBlock` on the next round-trip.
 */
export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * The outcome of a dispatched tool call, supplied by the orchestrator on the
 * following `complete` call so the model can continue the same turn.
 */
export interface ToolResultBlock {
  toolCallId: string;
  content: string;
  isError?: boolean;
}

/**
 * One completed round of a multi-step tool loop: the assistant turn that emitted
 * `toolCalls` (plus any `assistantText` it produced alongside them) and the
 * `toolResults` the orchestrator dispatched in response.
 *
 * The provider's Messages API requires every `tool_result` to follow an
 * assistant turn carrying the matching `tool_use`; this pairs them so the
 * connector can render that structure faithfully. Both halves travel in the
 * already-normalized {@link ToolCall} / {@link ToolResultBlock} shapes — no
 * vendor turn-structure crosses the boundary (ADR 0007). Each `ToolResultBlock`
 * pairs to its originating call by `toolCallId === ToolCall.id`.
 */
export interface ToolRound {
  toolCalls: ToolCall[];
  toolResults: ToolResultBlock[];
  assistantText?: string;
}

/**
 * Optional per-call feature toggles. An unsupported feature degrades to a no-op
 * (never an error) — the connector consults its `capabilities` first.
 */
export interface AiFeatureFlags {
  promptCaching?: boolean;
  contextEditing?: boolean;
}

/**
 * A single normalized request for one model round-trip. `system` and `messages`
 * arrive already ordered (ADR 0004); the connector only applies cache markers
 * and maps to the provider wire format. Block assembly/ordering is Task 3.
 *
 * `toolRounds`, when present, are the completed tool-loop rounds from earlier in
 * this same user turn, in order. They are rendered after `messages` (the
 * volatile tail, below the cache breakpoints) as alternating assistant
 * (`tool_use`) / user (`tool_result`) turns, so the model can continue a
 * multi-step loop. The connector performs ONE round-trip; the loop itself is
 * driven by the orchestrator (Task 3) re-calling `complete` with each new round
 * appended.
 */
export interface CompletionRequest {
  modelRole: AiModelRole;
  system?: PromptBlock[];
  messages: PromptBlock[];
  tools?: ToolSchema[];
  toolRounds?: ToolRound[];
  maxTokens?: number;
  features?: AiFeatureFlags;
  /**
   * Optional tool-choice directive for this round-trip (vendor-neutral). Omitted
   * or `'auto'` means the model decides; `'any'` forces some tool call; `{ name }`
   * forces a specific tool. The narration re-drive (ADR 0009) sets `'any'` for
   * the next round only to nudge a stalled model into actually calling its tools.
   */
  toolChoice?: AiToolChoice;
  /**
   * Opaque correlation id for this user turn, threaded controller → queue →
   * loop. Logged (never sent to the provider) so a failed round-trip can be tied
   * back to the originating update.
   */
  traceId?: string;
}

/**
 * Token accounting for one call, surfaced so callers can persist `tokenCount`
 * and build a cost / cache-hit view. Cache fields are 0 when the provider
 * reports nothing (e.g. caching disabled or a cold prefix).
 */
export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/**
 * The normalized result of one round-trip: a final text answer and/or tool
 * calls for the orchestrator to run, plus the stop reason and token usage.
 */
export interface CompletionResult {
  stopReason: AiStopReason;
  text?: string;
  toolCalls?: ToolCall[];
  usage: AiUsage;
}

/**
 * What a connector implementation supports. Callers branch on these instead of
 * assuming one vendor's features (ADR 0007).
 */
export interface AiCapabilities {
  promptCaching: boolean;
  contextEditing: boolean;
  structuredOutput: boolean;
}
