import { Injectable } from '@nestjs/common';
import { DateTime } from 'luxon';

import { HELP_TEXT } from '../assistant.prompts';
import { formatTaskLine } from '../event-formatting';
import { ScheduleReaderService } from '../schedule-reader.service';
import { User } from '@/modules/database/entities';
import { Occurrence } from '@/modules/recurrence-rule/recurrence.types';

/**
 * The result of running a slash command deterministically: the reply to send to
 * the user and a one-line synthetic summary to persist so the model stays aware
 * of what happened without an LLM call (spec "Commands").
 */
export interface CommandResult {
  reply: string;
  syntheticLine: string;
}

/**
 * Handles slash commands for an already-linked user. Each command runs without
 * the LLM and yields both a user reply and a synthetic summary line. `/start`
 * and `/link` for an unlinked chat are handled earlier by the linking flow; here
 * they just acknowledge the existing link.
 */
@Injectable()
export class CommandHandlerService {
  constructor(private readonly scheduleReader: ScheduleReaderService) {}

  /**
   * Renders an agenda reply + synthetic line for a labelled date window. Commands
   * don't drive a tool loop, so occurrences are rendered without a handle alias.
   */
  private static renderAgenda(
    label: string,
    occurrences: Occurrence[],
    timezone: string,
  ): CommandResult {
    if (occurrences.length === 0) {
      return {
        reply: `${label}: nothing scheduled.`,
        syntheticLine: `[user ran a command → ${label}: 0 events]`,
      };
    }

    const lines = occurrences.map((occurrence) =>
      formatTaskLine(occurrence, timezone),
    );

    return {
      reply: `${label}:\n${lines.join('\n')}`,
      syntheticLine: `[user ran a command → ${label}: ${occurrences.length} events: ${lines.join('; ')}]`,
    };
  }

  /**
   * Loads and renders the occurrence-aware agenda for the day window starting at
   * `dayStart` — expanding recurring instances, matching the AI agenda's
   * timed-only default (no timeless todos).
   */
  private async agendaForDay(
    user: User,
    label: string,
    dayStart: DateTime,
  ): Promise<CommandResult> {
    const occurrences = await this.scheduleReader.occurrencesInRange(
      user.id,
      dayStart.toJSDate(),
      dayStart.plus({ days: 1 }).toJSDate(),
    );

    return CommandHandlerService.renderAgenda(
      label,
      occurrences,
      user.timezone,
    );
  }

  /**
   * Loads and renders the next seven days of occurrences (recurring instances
   * expanded; timed-only, matching the AI agenda default).
   */
  private async agendaForWeek(user: User): Promise<CommandResult> {
    const from = DateTime.now().setZone(user.timezone).startOf('day');
    const occurrences = await this.scheduleReader.occurrencesInRange(
      user.id,
      from.toJSDate(),
      from.plus({ days: 7 }).toJSDate(),
    );

    return CommandHandlerService.renderAgenda(
      'The next 7 days',
      occurrences,
      user.timezone,
    );
  }

  /**
   * Finds and renders the user's next upcoming occurrence from now — the first
   * occurrence (recurring instances included) whose start is at or after now,
   * sorted by start, so a recurring instance is never missed.
   */
  private async nextEvent(user: User): Promise<CommandResult> {
    const now = DateTime.now().setZone(user.timezone);
    const occurrences = await this.scheduleReader.occurrencesInRange(
      user.id,
      now.toJSDate(),
      now.plus({ days: 30 }).toJSDate(),
    );

    const nowMs = now.toMillis();
    const upcoming = occurrences
      .filter(
        (occurrence): occurrence is Occurrence & { occurrenceStart: Date } =>
          occurrence.occurrenceStart !== null &&
          occurrence.occurrenceStart.getTime() >= nowMs,
      )
      .sort(
        (left, right) =>
          left.occurrenceStart.getTime() - right.occurrenceStart.getTime(),
      )[0];

    if (!upcoming) {
      return {
        reply: 'Nothing on the calendar in the next 30 days.',
        syntheticLine: '[user ran /next → no upcoming event]',
      };
    }

    const line = formatTaskLine(upcoming, user.timezone);

    return {
      reply: `Next up: ${line}`,
      syntheticLine: `[user ran /next → ${line}]`,
    };
  }

  /**
   * Runs the given command for a linked user, returning the reply + synthetic
   * line. Unknown commands fall back to the help text.
   */
  async handle(
    user: User,
    command: string,
    _args: string[],
  ): Promise<CommandResult> {
    const timezone = user.timezone;
    const today = DateTime.now().setZone(timezone).startOf('day');

    switch (command) {
      case 'today':
        return this.agendaForDay(user, "Today's events", today);
      case 'tomorrow':
        return this.agendaForDay(
          user,
          "Tomorrow's events",
          today.plus({ days: 1 }),
        );
      case 'week':
        return this.agendaForWeek(user);
      case 'next':
        return this.nextEvent(user);
      case 'start':
      case 'link':
        return {
          reply: "We're connected. What can I do for you?",
          syntheticLine: `[user ran /${command} → already linked]`,
        };
      case 'help':
        return {
          reply: HELP_TEXT,
          syntheticLine: '[user ran /help]',
        };
      default:
        return {
          reply: `I don't recognize /${command}. ${HELP_TEXT}`,
          syntheticLine: `[user ran an unknown command /${command}]`,
        };
    }
  }
}
