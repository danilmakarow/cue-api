import { Inject, Injectable } from '@nestjs/common';
import { DateTime } from 'luxon';

import { AssistantConfig } from './assistant.config';
import { ASSISTANT_SYSTEM_PROMPT } from './assistant.prompts';
import { formatTaskLine } from './event-formatting';
import { ScheduleReaderService } from './schedule-reader.service';
import { LAST_BUTTON_STORE } from './session/last-button.store';
import type { LastButtonReadPort } from './session/last-button.store';
import { HandleMap } from './tools/handle-map';
import { toolRegistry } from './tools/tool-registry';
import { PromptBlock, PromptRole, ToolSchema } from '@/modules/ai/ai.types';
import {
  ConflictPolicy,
  ConversationMessage,
  ConversationMessageRole,
  TaskGroup,
  User,
  UserMemoryFact,
} from '@/modules/database/entities';
import {
  ConversationMessageDatabaseService,
  ConversationSummaryDatabaseService,
  PersonaPromptDatabaseService,
  UserMemoryFactDatabaseService,
} from '@/modules/database/services';
import { DEFAULT_PERSONA_TEXT } from '@/modules/persona/persona.constants';
import { TaskGroupService } from '@/modules/task-group/task-group.service';

/** Max characters of a memory fact's value rendered into the profile block. */
const MAX_FACT_VALUE_CHARS = 120;

/**
 * The assembled prompt the orchestrator hands to the AI connector: the shared
 * + per-user `system` blocks (with the two cache breakpoints), the tool
 * definitions, and the volatile `messages` (now-context + recent window + the
 * new user turn). See ADR 0004 for the block order and breakpoints.
 */
export interface BuiltPrompt {
  system: PromptBlock[];
  tools: ToolSchema[];
  messages: PromptBlock[];
  /**
   * The user's STANDING double-booking policy (Story 15 / ADR 0011 + 0044),
   * resolved here from their EXPLICIT `conflict_policy` fact, so the orchestrator
   * can thread it onto the {@link ToolDispatchContext} and the conflict gate can
   * honour it without a round-trip. Null when no explicit policy is set (the gate
   * then runs default-deny). It is ALSO restated to the model in the volatile
   * now-context, so the model's judgement and the dispatcher's gate share one
   * source of truth.
   */
  conflictPolicy: ConflictPolicy | null;
}

/** Inputs the builder needs for one user turn. */
export interface BuildPromptInput {
  user: User;
  conversationId: string;
  currentMessageText: string;
  /**
   * The turn's {@link HandleMap}, created once by the orchestrator. The builder
   * seeds it with an alias per rendered occurrence while assembling the agenda
   * and query-aware slices, so the same handles resolve when the model later
   * calls a mutation tool with the same map in its dispatch context.
   */
  handleMap: HandleMap;
}

/**
 * Assembles the per-turn prompt in the fixed block order with two cache
 * breakpoints and the timestamp below both (ADR 0004), pulling the three memory
 * tiers (ADR 0005) and the preloaded + query-aware schedule (ADR 0006 layers
 * 1–2). The shared system prompt is marked as breakpoint #1 (shared across all
 * users; its cached prefix also covers the tool definitions, which precede
 * `system` in the provider prefix), and the rolling summary as breakpoint #2
 * (end of the per-user stable region). The per-user PERSONA (Story 18 / ADR
 * 0014) sits inside that region — between profile/groups and the summary, with
 * no boundary of its own — so it never leaks into the cross-user block-1 prefix.
 * All volatile data — now, agenda, recent window, new message — sits after both.
 */
@Injectable()
export class ContextBuilderService {
  constructor(
    private readonly config: AssistantConfig,
    private readonly conversationMessageDatabaseService: ConversationMessageDatabaseService,
    private readonly conversationSummaryDatabaseService: ConversationSummaryDatabaseService,
    private readonly userMemoryFactDatabaseService: UserMemoryFactDatabaseService,
    private readonly personaPromptDatabaseService: PersonaPromptDatabaseService,
    private readonly scheduleReader: ScheduleReaderService,
    private readonly taskGroupService: TaskGroupService,
    @Inject(LAST_BUTTON_STORE)
    private readonly lastButtonStore: LastButtonReadPort,
  ) {}

  /**
   * Renders the durable profile (prompt block 3) from the user's memory facts,
   * or a stable placeholder when there are none (kept byte-stable for caching).
   */
  private static renderProfile(facts: UserMemoryFact[]): string {
    if (facts.length === 0) {
      return 'User profile: no stored preferences yet.';
    }

    const lines = facts.map((fact) => {
      const value = JSON.stringify(fact.value);
      const trimmed =
        value.length > MAX_FACT_VALUE_CHARS
          ? `${value.slice(0, MAX_FACT_VALUE_CHARS)}…`
          : value;

      return `- ${fact.type}/${fact.key}: ${trimmed}`;
    });

    return `User profile:\n${lines.join('\n')}`;
  }

  /**
   * Renders the active persona block (Story 18 / ADR 0014) for the PER-USER
   * stable region. The text is the user's own persona, the seeded preset, or the
   * code-constant default — resolved before this call so the block is always
   * present and byte-stable for a given persona (a cache hit for the breakpoint-#2
   * region holds until the persona OR the summary changes). It carries NO
   * `cacheBoundary` of its own: the region is closed by the summary's breakpoint
   * #2, and block 1 (system prompt + tool defs) is left byte-stable across users.
   */
  private static renderPersona(personaText: string): string {
    return `Adopt this assistant persona for all replies:\n${personaText}`;
  }

  /**
   * Renders the user's STANDING double-booking policy as a one-line instruction
   * for the model (Story 15 / ADR 0011 + 0044), or null when none is set so the
   * caller omits the line (the model then follows the system-prompt default-deny
   * rule). `ALLOW` and `DENY` are stated as firm directives so the model's own
   * judgement matches the dispatcher's gate exactly; an explicit `ASK` restates
   * the default so a user who set "always ask" sees it honoured. Kept in the
   * volatile now-context (not the cached prefix) because it is per-user and may
   * change between turns.
   */
  private static renderConflictPolicy(
    policy: ConflictPolicy | null,
  ): string | null {
    if (policy === ConflictPolicy.ALLOW) {
      return 'Standing conflict policy: ALLOW. The user has authorized booking over overlaps once and for all — you may set confirmOverlap:true on a clashing write WITHOUT asking. This still does NOT authorize deleting or overwriting an existing commitment; a delete always asks first.';
    }

    if (policy === ConflictPolicy.DENY) {
      return 'Standing conflict policy: DENY. The user never wants overlaps — refuse any clashing write and do not even ask; offer a non-overlapping slot instead. Never set confirmOverlap.';
    }

    if (policy === ConflictPolicy.ASK) {
      return 'Standing conflict policy: ASK. Always ask the user before booking over any overlap (the default).';
    }

    return null;
  }

  /**
   * Renders the user's task groups as a compact, name-only line for the per-user
   * stable region (cache-friendly — groups change rarely). Returns null when the
   * user has no groups so the caller omits the line entirely. Names only: the
   * model assigns/filters by name, and no volatile aliases sit above the cache
   * breakpoint.
   */
  private static renderGroups(groups: TaskGroup[]): string | null {
    if (groups.length === 0) {
      return null;
    }

    const names = groups.map((group) => group.name).join(', ');

    return `Groups: ${names}`;
  }

  /**
   * Maps a stored conversation message to a prompt block; only assistant turns
   * keep the assistant role, everything else (user, tool, synthetic) is supplied
   * as user-role context.
   */
  private static toPromptBlock(message: ConversationMessage): PromptBlock {
    const role =
      message.role === ConversationMessageRole.ASSISTANT
        ? PromptRole.ASSISTANT
        : PromptRole.USER;

    return { role, content: message.content };
  }

  /**
   * Builds the volatile now-context + preloaded agenda text (prompt block 5).
   * Carries the current datetime and the user's timezone — kept out of the
   * cached prefix on purpose so a cache hit isn't broken every turn. Renders each
   * occurrence with a `[eN]` handle seeded into `handleMap` so the model can
   * address it in a follow-up mutation tool within the same turn.
   */
  private async buildNowContext(
    user: User,
    handleMap: HandleMap,
  ): Promise<string> {
    const now = DateTime.now().setZone(user.timezone);
    const horizonDays = this.config.preloadHorizonDays;
    const from = now.startOf('day');
    const to = from.plus({ days: horizonDays });

    const agenda = await this.scheduleReader.occurrencesInRange(
      user.id,
      from.toJSDate(),
      to.toJSDate(),
    );

    const header = `Current time: ${now.toFormat(
      'cccc dd LLL yyyy HH:mm',
    )} (${user.timezone}).`;

    if (agenda.length === 0) {
      return `${header}\nAgenda (next ${horizonDays} days): nothing scheduled.`;
    }

    const lines = agenda.map((occurrence) =>
      formatTaskLine(
        occurrence,
        user.timezone,
        handleMap.addOccurrence(occurrence),
      ),
    );

    return `${header}\nAgenda (next ${horizonDays} days):\n${lines.join('\n')}`;
  }

  /**
   * Extracts explicit `YYYY-MM-DD` date references from the message that fall
   * outside the preloaded horizon and loads that day's events (ADR 0006 layer 2,
   * deterministic path). A Haiku fallback for fuzzier phrasing is deferred; the
   * on-demand fetch tool (layer 3) covers anything missed here.
   */
  private async buildQueryAwareSlice(
    user: User,
    messageText: string,
    handleMap: HandleMap,
  ): Promise<string | null> {
    const isoDates = messageText.match(/\d{4}-\d{2}-\d{2}/g);

    if (!isoDates) {
      return null;
    }

    const horizonEnd = DateTime.now()
      .setZone(user.timezone)
      .startOf('day')
      .plus({ days: this.config.preloadHorizonDays });
    const uniqueDates = Array.from(new Set(isoDates));
    const sections: string[] = [];

    for (const isoDate of uniqueDates) {
      const day = DateTime.fromISO(isoDate, { zone: user.timezone });

      if (!day.isValid || day < horizonEnd) {
        continue;
      }

      const occurrences = await this.scheduleReader.occurrencesInRange(
        user.id,
        day.startOf('day').toJSDate(),
        day.endOf('day').toJSDate(),
      );

      const body =
        occurrences.length === 0
          ? 'nothing scheduled.'
          : occurrences
              .map((occurrence) =>
                formatTaskLine(
                  occurrence,
                  user.timezone,
                  handleMap.addOccurrence(occurrence),
                ),
              )
              .join('\n');

      sections.push(`${isoDate}:\n${body}`);
    }

    if (sections.length === 0) {
      return null;
    }

    return `Referenced dates:\n${sections.join('\n')}`;
  }

  /**
   * Assembles the full prompt for one user turn. The current message text is
   * folded into the final user turn together with the now-context and agenda so
   * the timestamp stays below both cache breakpoints.
   */
  async build(input: BuildPromptInput): Promise<BuiltPrompt> {
    const facts = await this.userMemoryFactDatabaseService.findAllByUserId(
      input.user.id,
    );
    const conflictPolicy =
      await this.userMemoryFactDatabaseService.findConflictPolicy(
        input.user.id,
      );
    const groups = await this.taskGroupService.findAllForUser(input.user.id);
    const personaText =
      (await this.personaPromptDatabaseService.findActivePersonaText(
        input.user.id,
      )) ?? DEFAULT_PERSONA_TEXT;
    const summary = await this.conversationSummaryDatabaseService.findLatest(
      input.conversationId,
    );

    const windowWithCurrent =
      await this.conversationMessageDatabaseService.findRecentWindow(
        input.conversationId,
        this.config.recentWindowSize + 1,
      );
    // Drop the just-persisted current turn; it is re-added folded with context.
    const priorWindow = windowWithCurrent.slice(0, -1);

    const nowContext = await this.buildNowContext(input.user, input.handleMap);
    const queryAware = await this.buildQueryAwareSlice(
      input.user,
      input.currentMessageText,
      input.handleMap,
    );

    const groupsLine = ContextBuilderService.renderGroups(groups);

    const stableUserBlocks: PromptBlock[] = [
      {
        role: PromptRole.USER,
        content: ContextBuilderService.renderProfile(facts),
      },
    ];

    if (groupsLine !== null) {
      stableUserBlocks.push({ role: PromptRole.USER, content: groupsLine });
    }

    // Per-user persona (Story 18 / ADR 0014): injected into the per-user stable
    // region — AFTER profile/groups, BEFORE the rolling summary — with NO
    // `cacheBoundary`. It is closed by the summary's breakpoint #2 and never
    // touches block 1 (the shared system prompt + tool defs), which stays
    // byte-stable across users so the cross-user cached prefix keeps hitting.
    stableUserBlocks.push({
      role: PromptRole.USER,
      content: ContextBuilderService.renderPersona(personaText),
    });

    const system: PromptBlock[] = [
      {
        role: PromptRole.USER,
        content: ASSISTANT_SYSTEM_PROMPT,
        // Breakpoint #1 — shared across all users (also covers the tool defs).
        cacheBoundary: true,
      },
      ...stableUserBlocks,
      {
        role: PromptRole.USER,
        content: summary
          ? `Conversation summary so far:\n${summary.summaryText}`
          : 'No earlier conversation summary.',
        // Breakpoint #2 — end of the per-user stable region.
        cacheBoundary: true,
      },
    ];

    const conflictPolicyLine =
      ContextBuilderService.renderConflictPolicy(conflictPolicy);

    // Latest reply-keyboard button outcome (Story 16 / ADR 0045), read-then-cleared
    // for a one-shot injection into THIS turn's volatile tail ONLY — never the
    // cached prefix (the system/profile/groups/summary blocks above stay byte-stable
    // so the ADR 0004 cache breakpoints keep hitting). Placed in the volatile final
    // user content alongside the now-context, so a button the user just tapped is
    // recent context for the model without ever touching the cached region.
    const lastButtonOutcome = await this.lastButtonStore.takeLatest(
      input.user.id,
    );
    const lastButtonLine =
      lastButtonOutcome === null
        ? null
        : `Recent action (you, via a menu button): ${lastButtonOutcome}`;

    const finalUserContent = [
      nowContext,
      queryAware,
      conflictPolicyLine,
      lastButtonLine,
      `New message: ${input.currentMessageText}`,
    ]
      .filter((section): section is string => section !== null)
      .join('\n\n');

    const messages: PromptBlock[] = [
      ...priorWindow.map((entry) => ContextBuilderService.toPromptBlock(entry)),
      { role: PromptRole.USER, content: finalUserContent },
    ];

    const tools = await toolRegistry.toSchemas();

    return { system, tools, messages, conflictPolicy };
  }
}
