import { Inject, Injectable, Logger } from '@nestjs/common';
import { DateTime } from 'luxon';
import { z } from 'zod';

import { buildParseSystemPrompt } from './assistant.prompts';
import { TaskDraftDTO } from './dtos';
import { recurrenceInputSchema } from './tools/tool-schemas';
import { AiConnector } from '@/modules/ai/ai-connector.abstract';
import { ACTIVE_AI_CONNECTOR } from '@/modules/ai/ai.module';
import { AiModelRole, PromptRole } from '@/modules/ai/ai.types';
import { User } from '@/modules/database/entities';
import { TaskGroupService } from '@/modules/task-group/task-group.service';

/**
 * Structured draft the BACKGROUND model returns for one parse call (D4). Mirrors
 * the `create_task` tool grammar but limited to the quick-create fields, and
 * carries a `groupName` (resolved to an id by the service) — never a group id, so
 * the model only ever picks from the existing group names it was shown. All
 * scheduling fields are optional: the model omits a time / duration / recurrence /
 * group it cannot justify from the text rather than inventing one.
 */
const taskDraftResultSchema = z.object({
  title: z.string().min(1),
  start: z.string().optional(),
  durationMinutes: z.number().int().positive().optional(),
  recurrence: recurrenceInputSchema.optional(),
  groupName: z.string().optional(),
});

/** Inferred type of the model's raw parse result. */
type TaskDraftResult = z.infer<typeof taskDraftResultSchema>;

/**
 * Owns the REST natural-language quick-create PARSE (D4): turns one line of plain
 * language into a structured {@link TaskDraftDTO} for the iOS quick-create well
 * WITHOUT creating a task. It reuses the assistant's AI connector and the
 * `create_task` recurrence grammar, but deliberately does NOT run the tool loop —
 * the model is a pure extractor here, so no schedule reads, no conflict checks,
 * and no writes ever happen. Group names are resolved to an existing group id;
 * an unknown / unmatched group is dropped (never created).
 */
@Injectable()
export class ParseService {
  private readonly logger = new Logger(ParseService.name);

  constructor(
    @Inject(ACTIVE_AI_CONNECTOR) private readonly ai: AiConnector,
    private readonly taskGroupService: TaskGroupService,
  ) {}

  /**
   * Parses one line of natural language into a structured task draft for the
   * given user (D4). Resolves the user's "now" + timezone and existing group
   * names so relative phrasing and group matching work, asks the BACKGROUND model
   * for a strict structured draft, then maps it to the REST shape — resolving the
   * model's `groupName` to a real group id (dropped when it matches none). Never
   * creates anything.
   */
  async parse(user: User, text: string): Promise<TaskDraftDTO> {
    const groups = await this.taskGroupService.findAllForUser(user.id);
    const groupNames = groups.map((group) => group.name);
    const nowIso = DateTime.now().setZone(user.timezone).toISO() ?? '';

    const system = buildParseSystemPrompt(nowIso, user.timezone, groupNames);

    const result = await this.ai.completeStructured(
      {
        modelRole: AiModelRole.BACKGROUND,
        system: [{ role: PromptRole.USER, content: system }],
        messages: [{ role: PromptRole.USER, content: text }],
      },
      taskDraftResultSchema,
    );

    return this.toDraft(result, user.id);
  }

  /**
   * Maps the model's raw {@link TaskDraftResult} to the REST {@link TaskDraftDTO},
   * resolving `groupName` to an existing group's id. A name matching no group (the
   * model picked something not in the list) is silently dropped — parse never
   * creates a group — and only fields the model actually populated are included.
   */
  private async toDraft(
    result: TaskDraftResult,
    userId: string,
  ): Promise<TaskDraftDTO> {
    const draft: TaskDraftDTO = { title: result.title };

    if (result.start !== undefined) {
      draft.start = result.start;
    }

    if (result.durationMinutes !== undefined) {
      draft.durationMinutes = result.durationMinutes;
    }

    if (result.recurrence !== undefined) {
      draft.recurrence = result.recurrence;
    }

    if (result.groupName !== undefined) {
      const groupId = await this.resolveGroupId(userId, result.groupName);

      if (groupId !== null) {
        draft.groupId = groupId;
      }
    }

    return draft;
  }

  /**
   * Resolves a group NAME the model returned to an existing group's id for the
   * user, or null when no group matches (the draft then omits `groupId`). Picks
   * the first match when a name exists in more than one calendar — parse only
   * needs a sensible default the user can change on confirm.
   */
  private async resolveGroupId(
    userId: string,
    groupName: string,
  ): Promise<string | null> {
    const matches = await this.taskGroupService.findByName(userId, groupName);

    if (matches.length === 0) {
      return null;
    }

    return matches[0].id;
  }
}
