import { ZodType, z } from 'zod';

import { ToolDispatchContext, ToolDispatchOutcome } from '../assistant.types';

/**
 * The behavioral host a tool's {@link Tool.run} delegates into — the
 * {@link ToolDispatcherService}, which still owns every handler body and the
 * shared helpers (`attemptCreate`, `resolveGroup`, calendar/handle resolution).
 * Keeping the host as the single home of that logic preserves the 3-layer data
 * access rule (only feature services are touched) and the exact dispatch
 * behavior the unit suite pins, while the registry single-sources the metadata.
 *
 * It is a structural alias of the dispatcher's public handler surface; each
 * method maps 1:1 to a tool's `run`. `set_reminder` is synchronous today, so its
 * host method returns a plain outcome — the registry awaits both uniformly.
 */
export interface ToolHandlerHost {
  handleListTasks(
    input: Record<string, unknown>,
    context: ToolDispatchContext,
  ): Promise<ToolDispatchOutcome>;
  handleFindFreeSlots(
    input: Record<string, unknown>,
    context: ToolDispatchContext,
  ): Promise<ToolDispatchOutcome>;
  handleCreateTask(
    input: Record<string, unknown>,
    context: ToolDispatchContext,
  ): Promise<ToolDispatchOutcome>;
  handleCreateTasks(
    input: Record<string, unknown>,
    context: ToolDispatchContext,
  ): Promise<ToolDispatchOutcome>;
  handleUpdateTask(
    input: Record<string, unknown>,
    context: ToolDispatchContext,
  ): Promise<ToolDispatchOutcome>;
  handleCompleteTask(
    input: Record<string, unknown>,
    context: ToolDispatchContext,
  ): Promise<ToolDispatchOutcome>;
  handleDeleteTask(
    input: Record<string, unknown>,
    context: ToolDispatchContext,
  ): Promise<ToolDispatchOutcome>;
  handleSetReminder(
    input: Record<string, unknown>,
    context: ToolDispatchContext,
  ): ToolDispatchOutcome;
  handleListGroups(
    input: Record<string, unknown>,
    context: ToolDispatchContext,
  ): Promise<ToolDispatchOutcome>;
  handleCreateGroup(
    input: Record<string, unknown>,
    context: ToolDispatchContext,
  ): Promise<ToolDispatchOutcome>;
  handleCheckAvailability(
    input: Record<string, unknown>,
    context: ToolDispatchContext,
  ): Promise<ToolDispatchOutcome>;
  handleAskUser(
    input: Record<string, unknown>,
    context: ToolDispatchContext,
  ): ToolDispatchOutcome;
}

/**
 * A model-facing JSON Schema fragment for a tool's `input_schema`, kept as a
 * loose object so a hand-written fragment (byte-pinned for ADR-0004 cache
 * stability) and a Zod-derived one share one type.
 */
export type ToolJsonSchema = Record<string, unknown>;

/**
 * A single tool the model may call, single-sourced. `prompt()` is the
 * model-facing description; `inputSchema` is the Zod validator that already
 * carries every field's `.describe(...)`; `jsonSchema` is the EXACT model-facing
 * `input_schema` fragment (byte-pinned so the cached tool-defs prefix never
 * shifts — ADR 0004); `isWrite()` / `isScheduleFetch()` declare the tool's
 * accounting class (fail-closed by default); `run()` executes it via the
 * {@link ToolHandlerHost}, returning the normalized {@link ToolDispatchOutcome}.
 */
export interface Tool<Input = unknown> {
  name: string;
  prompt(): string | Promise<string>;
  inputSchema: ZodType<Input>;
  /**
   * The verbatim model-facing JSON Schema. Present for every migrated tool so
   * the derived schema is byte-equivalent to the hand-written one; when omitted,
   * {@link ToolRegistry.toSchemas} derives it from `inputSchema` via the same
   * Zod v4 bridge the connector uses.
   */
  jsonSchema?: ToolJsonSchema;
  isWrite(): boolean;
  isScheduleFetch(): boolean;
  run(
    input: Record<string, unknown>,
    context: ToolDispatchContext,
    host: ToolHandlerHost,
  ): Promise<ToolDispatchOutcome>;
}

/**
 * The partial shape a tool author supplies to {@link buildTool}. Only the
 * always-required members are mandatory; the accounting predicates default to
 * fail-closed (a tool is neither a write nor a schedule-fetch unless it opts in).
 */
export type ToolDefinition<Input = unknown> = Partial<Tool<Input>> &
  Pick<Tool<Input>, 'name' | 'prompt' | 'inputSchema' | 'run'>;

/**
 * Fail-closed defaults spread FIRST by {@link buildTool}: a tool is neither a
 * write nor a schedule-fetch unless its definition overrides the predicate. New
 * tools therefore never silently count against the schedule-fetch read cap or
 * the committed-write guard until they explicitly declare that they should.
 */
export const TOOL_DEFAULTS = {
  isWrite: (): boolean => false,
  isScheduleFetch: (): boolean => false,
} as const;

/**
 * Converts a Zod schema to a plain JSON Schema object using the same Zod v4
 * bridge the connector's `completeStructured` uses (`z.toJSONSchema`), so a
 * future tool that omits an explicit `jsonSchema` still gets a model-facing
 * shape derived from the single Zod source of truth.
 */
export const zodToJsonSchema = (schema: ZodType): ToolJsonSchema =>
  z.toJSONSchema(schema) as ToolJsonSchema;

/**
 * Builds a {@link Tool} from a partial definition, spreading {@link TOOL_DEFAULTS}
 * FIRST so the fail-closed predicates apply unless the definition overrides them.
 * The single construction point for every tool, keeping the metadata, the
 * validator, the prompt, and the run body co-located per tool.
 */
export const buildTool = <Input>(def: ToolDefinition<Input>): Tool<Input> => ({
  ...TOOL_DEFAULTS,
  ...def,
});
