import { Injectable } from '@nestjs/common';

import { Occurrence } from '@/modules/recurrence-rule/recurrence.types';
import {
  FindOccurrencesOptions,
  TaskService,
} from '@/modules/task/task.service';

/**
 * Reads schedule data for the assistant across a user's calendars, going only
 * through the existing feature services (TaskService) — never repositories.
 * Centralizes the occurrence-aware "all calendars in a range, merged + sorted"
 * query the context builder, tool dispatcher, and command handler all need.
 */
@Injectable()
export class ScheduleReaderService {
  constructor(private readonly taskService: TaskService) {}

  /**
   * Returns the occurrence-aware view of `[from, to)` — one-off tasks plus
   * expanded recurring instances, merged and sorted by start — delegating to
   * `TaskService.findOccurrencesInRange`, which already spans every calendar the
   * user owns when no `calendarId` is given. Used by the task-domain tools and
   * (after Task A2) the preloaded agenda.
   */
  async occurrencesInRange(
    userId: string,
    from: Date,
    to: Date,
    opts: FindOccurrencesOptions = {},
  ): Promise<Occurrence[]> {
    return this.taskService.findOccurrencesInRange(userId, from, to, opts);
  }
}
