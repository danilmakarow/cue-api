import { Inject, Injectable, Logger } from '@nestjs/common';
import { DateTime } from 'luxon';

import { buildDailyReportSystemPrompt } from './report.prompts';
import { AiConnector } from '@/modules/ai/ai-connector.abstract';
import { ACTIVE_AI_CONNECTOR } from '@/modules/ai/ai.module';
import { AiModelRole, PromptRole } from '@/modules/ai/ai.types';
import { User } from '@/modules/database/entities';
import { UserBriefSettingsDatabaseService } from '@/modules/database/services';
import { Occurrence } from '@/modules/recurrence-rule/recurrence.types';
import { TaskService } from '@/modules/task/task.service';

/** Output-token ceiling for a daily report — a few friendly sentences need little. */
const REPORT_MAX_TOKENS = 400;

/**
 * Builds the day's agenda for a user and turns it into ONE friendly daily report
 * via a SINGLE MAIN-model `complete()` call (Story 17 / ADR 0046) — no tool loop,
 * no dispatcher. Reads the user's local day with `TaskService.findOccurrencesInRange`
 * (recurrence expanded, exceptions applied, DST-correct), renders a compact agenda
 * line per occurrence, and asks the model for a short briefing.
 */
@Injectable()
export class ReportGeneratorService {
  private readonly logger = new Logger(ReportGeneratorService.name);

  constructor(
    @Inject(ACTIVE_AI_CONNECTOR) private readonly ai: AiConnector,
    private readonly taskService: TaskService,
    private readonly userBriefSettingsDatabaseService: UserBriefSettingsDatabaseService,
  ) {}

  /**
   * Renders a day's occurrences into a compact, model-readable agenda. Each timed
   * occurrence becomes a `HH:mm Title` line in the user's timezone; timeless items
   * are omitted (the report covers the day's schedule). Returns a sentinel line
   * when the day is empty so the model knows to reassure rather than invent.
   */
  private static renderAgenda(
    occurrences: Occurrence[],
    timezone: string,
  ): string {
    const lines = occurrences
      .filter((occurrence) => occurrence.occurrenceStart !== null)
      .map((occurrence) => {
        const start = DateTime.fromJSDate(occurrence.occurrenceStart as Date, {
          zone: timezone,
        }).toFormat('HH:mm');

        return `${start} ${occurrence.title}`;
      });

    if (lines.length === 0) {
      return '(no scheduled items today)';
    }

    return lines.join('\n');
  }

  /**
   * Generates the daily report text for a user on their local `reportDate`
   * (`YYYY-MM-DD`, in `user.timezone`). Expands the local-day window to UTC,
   * fetches the agenda, and runs one MAIN-model completion. Returns the trimmed
   * report text, or null when the model produced nothing usable — the caller then
   * skips the send (and leaves the day un-marked so a later minute can retry).
   *
   * This method does NOT catch agenda/AI faults itself: the per-user caller in the
   * scheduler owns the try/catch so one user's failure never aborts the scan.
   */
  async generateForUser(
    user: User,
    reportDate: string,
    correlationId: string,
  ): Promise<string | null> {
    const dayStart = DateTime.fromISO(reportDate, {
      zone: user.timezone,
    }).startOf('day');
    const dayEnd = dayStart.plus({ days: 1 });

    const occurrences = await this.taskService.findOccurrencesInRange(
      user.id,
      dayStart.toJSDate(),
      dayEnd.toJSDate(),
    );

    const agenda = ReportGeneratorService.renderAgenda(
      occurrences,
      user.timezone,
    );

    const displayName = user.displayName ?? 'there';

    // Personalize the base prompt with the user's own preferences when set — the
    // custom prompt AUGMENTS the base structure/safety/format rules, never
    // replaces them.
    const customPrompt =
      await this.userBriefSettingsDatabaseService.findCustomPromptForUser(
        user.id,
      );
    const systemPrompt = buildDailyReportSystemPrompt(customPrompt);

    const result = await this.ai.complete({
      modelRole: AiModelRole.MAIN,
      system: [{ role: PromptRole.USER, content: systemPrompt }],
      messages: [
        {
          role: PromptRole.USER,
          content:
            `User name: ${displayName}\n` +
            `Local date: ${reportDate} (${user.timezone})\n` +
            `Today's schedule:\n${agenda}\n\n` +
            `Write the daily briefing.`,
        },
      ],
      maxTokens: REPORT_MAX_TOKENS,
      traceId: correlationId,
    });

    const report = result.text?.trim();

    if (!report) {
      this.logger.warn(
        `[cid=${correlationId}] Daily report for user ${user.id} produced empty text — skipping send.`,
      );

      return null;
    }

    return report;
  }
}
