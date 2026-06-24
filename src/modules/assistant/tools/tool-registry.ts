import { ZodError } from 'zod';

import { ToolDispatchContext, ToolDispatchOutcome } from '../assistant.types';
import { askUserTool } from './definitions/ask-user.tool';
import { checkAvailabilityTool } from './definitions/check-availability.tool';
import { completeTaskTool } from './definitions/complete-task.tool';
import { createGroupTool } from './definitions/create-group.tool';
import { createTaskTool } from './definitions/create-task.tool';
import { createTasksTool } from './definitions/create-tasks.tool';
import { deleteTaskTool } from './definitions/delete-task.tool';
import { findFreeSlotsTool } from './definitions/find-free-slots.tool';
import { listGroupsTool } from './definitions/list-groups.tool';
import { listTasksTool } from './definitions/list-tasks.tool';
import { setReminderTool } from './definitions/set-reminder.tool';
import { updateGroupTool } from './definitions/update-group.tool';
import { updateTaskTool } from './definitions/update-task.tool';
import { Tool, ToolHandlerHost, zodToJsonSchema } from './tool.contract';
import { ToolCall, ToolSchema } from '@/modules/ai/ai.types';

/**
 * The 13 tools in their STABLE, append-only registration order (ADR 0004): the
 * original nine, then `create_tasks`, `check_availability`, `ask_user`, and
 * `update_group` appended LAST so the derived schema array stays byte-order-stable
 * and the cached tool-defs prefix never shifts. New tools are ONLY ever appended,
 * never reordered.
 */
const REGISTERED_TOOLS: readonly Tool[] = [
  listTasksTool,
  findFreeSlotsTool,
  createTaskTool,
  updateTaskTool,
  completeTaskTool,
  deleteTaskTool,
  setReminderTool,
  listGroupsTool,
  createGroupTool,
  // APPENDED LAST so the tool order stays byte-stable for the ADR-0004 cache
  // prefix — new tools are only ever appended, never reordered.
  createTasksTool,
  checkAvailabilityTool,
  // `ask_user` (ADR 0010) appended after the read/write tools — it is the
  // suspend/resume clarifying-question tool, neither a write nor a fetch.
  askUserTool,
  // `update_group` (FEATURE R5) appended last — a group-mutation write.
  updateGroupTool,
] as const;

/**
 * Reduces a thrown value to the same short, model-actionable message the
 * dispatcher's `describeError` produces: the joined Zod issue messages for a
 * validation failure, the `Error.message` otherwise. Single-sourced here so the
 * registry's `safeParse` recoverable result reads identically to a thrown
 * validation error formatted by the dispatcher's try/catch.
 */
const describeToolError = (error: unknown): string => {
  if (error instanceof ZodError) {
    return error.issues.map((issue) => issue.message).join('; ');
  }

  return error instanceof Error ? error.message : 'unknown error';
};

/**
 * The single source of truth for the assistant's tool surface: the model-facing
 * schema list (prompt + input_schema), the write / schedule-fetch accounting
 * sets, and per-call validation + dispatch. Built once from the registered
 * {@link Tool} definitions; the dispatcher delegates execution here, while the
 * context builder and orchestrator consume the derived schemas / name sets.
 */
export class ToolRegistry {
  private readonly tools: readonly Tool[];

  private readonly byName: Map<string, Tool>;

  constructor(tools: readonly Tool[] = REGISTERED_TOOLS) {
    this.tools = tools;
    this.byName = new Map(tools.map((tool) => [tool.name, tool]));
  }

  /**
   * Derives the provider-neutral {@link ToolSchema}[] for the prompt, in the
   * registry's stable order. `description` is the tool's `prompt()` (awaited so a
   * future async prompt works); `inputSchema` is the verbatim hand-written
   * `jsonSchema` when present (byte-equivalent to the previous schema for cache
   * stability), else derived from the Zod validator via {@link zodToJsonSchema}.
   */
  async toSchemas(): Promise<ToolSchema[]> {
    return Promise.all(
      this.tools.map(async (tool) => ({
        name: tool.name,
        description: await tool.prompt(),
        inputSchema: tool.jsonSchema ?? zodToJsonSchema(tool.inputSchema),
      })),
    );
  }

  /**
   * The set of tool names that persist a calendar mutation — the orchestrator's
   * committed-write accounting. Derived from each tool's `isWrite()` predicate.
   */
  writeNames(): ReadonlySet<string> {
    return new Set(
      this.tools.filter((tool) => tool.isWrite()).map((tool) => tool.name),
    );
  }

  /**
   * The set of tool names that read schedule data and count against the per-turn
   * schedule-fetch read cap. Derived from each tool's `isScheduleFetch()`.
   */
  scheduleFetchNames(): ReadonlySet<string> {
    return new Set(
      this.tools
        .filter((tool) => tool.isScheduleFetch())
        .map((tool) => tool.name),
    );
  }

  /**
   * Validates the call's input against the tool's Zod schema (`safeParse`) and,
   * on success, runs it via the {@link ToolHandlerHost}. An unknown tool or a
   * validation failure becomes a recoverable `isError` tool result the model can
   * correct — never a throw — matching the dispatcher's previous behavior. A
   * throw from the tool body still propagates to the dispatcher's try/catch so
   * the existing error-formatting path is unchanged.
   */
  async run(
    toolCall: ToolCall,
    context: ToolDispatchContext,
    host: ToolHandlerHost,
  ): Promise<ToolDispatchOutcome> {
    const tool = this.byName.get(toolCall.name);

    if (!tool) {
      return {
        content: `Error: unknown tool "${toolCall.name}".`,
        isError: true,
      };
    }

    const parsed = tool.inputSchema.safeParse(toolCall.input);

    if (!parsed.success) {
      return {
        content: `Error: ${describeToolError(parsed.error)}`,
        isError: true,
      };
    }

    return tool.run(toolCall.input, context, host);
  }
}

/**
 * The shared registry instance. Stateless and immutable, so the metadata
 * consumers (context builder, orchestrator) and the dispatcher all read from one
 * source without DI plumbing for a value that never varies per request.
 */
export const toolRegistry = new ToolRegistry();

/**
 * Tools that read schedule data and therefore count against the per-turn
 * schedule-fetch read cap (ADR 0006 layer 3). Derived from the registry's
 * `isScheduleFetch()` predicates so the membership single-sources from the tool
 * definitions rather than a hand-maintained list (today: `list_tasks`,
 * `find_free_slots`, `check_availability`).
 */
export const SCHEDULE_FETCH_TOOLS: ReadonlySet<string> =
  toolRegistry.scheduleFetchNames();

/**
 * Tools that actually persist a calendar mutation. The orchestrator counts a
 * successful, non-held call to any of these as a committed write, so it can tell
 * whether a turn that *claimed* to act actually changed anything (the
 * "claimed-action but no write" guard) and report an accurate "saved N changes".
 * Derived from the registry's `isWrite()` predicates.
 *
 * Reads (`list_tasks`, `find_free_slots`, `list_groups`) are excluded — and so
 * is `set_reminder`: its handler is a no-op stub today ("reminders coming soon")
 * that writes nothing, so counting it would both mask a fabricated reminder
 * claim and inflate the saved-changes count. Re-add it (set `isWrite`) when
 * reminders persist.
 */
export const WRITE_TOOLS: ReadonlySet<string> = toolRegistry.writeNames();
