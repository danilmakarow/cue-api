import { Injectable } from '@nestjs/common';

import {
  NotificationChannel,
  NotificationRule,
} from '@/modules/database/entities';
import { NotificationRuleDatabaseService } from '@/modules/database/services';

/**
 * A single per-task reminder to persist: an offset (minutes from task start)
 * plus a delivery channel. The transport-agnostic input the task service hands
 * down so this service owns the `NotificationRule` lifecycle without importing
 * task DTOs.
 */
export interface ReminderInput {
  offsetMinutes: number;
  channel: NotificationChannel;
}

/**
 * Service owning per-task notification rules (S1): create, list-by-task, and
 * replace-on-update. Per-task reminders are persisted as `taskId`-linked
 * `NotificationRule` rows (strategy null), distinct from the strategy-owned
 * rules that compose a reusable strategy.
 */
@Injectable()
export class NotificationRuleService {
  constructor(
    private readonly notificationRuleDatabaseService: NotificationRuleDatabaseService,
  ) {}

  /**
   * Returns the per-task reminder rules for `taskId`, ordered by `offsetMinutes`
   * ascending (earliest-firing first) for a stable wire order.
   */
  async listByTask(taskId: string): Promise<NotificationRule[]> {
    return this.notificationRuleDatabaseService.findAll({
      where: { taskId },
      order: { offsetMinutes: 'ASC' },
    });
  }

  /**
   * Creates the given reminders as `taskId`-linked rules and returns the
   * persisted rows. Returns an empty array (no writes) when `reminders` is empty.
   */
  async createForTask(
    taskId: string,
    reminders: ReminderInput[],
  ): Promise<NotificationRule[]> {
    if (reminders.length === 0) return [];

    const created: NotificationRule[] = [];

    for (const reminder of reminders) {
      const rule = this.notificationRuleDatabaseService.createInstance({
        taskId,
        strategyId: null,
        offsetMinutes: reminder.offsetMinutes,
        channel: reminder.channel,
        messageTemplate: null,
      });

      created.push(await this.notificationRuleDatabaseService.save(rule));
    }

    return created;
  }

  /**
   * Replaces the full set of per-task reminders for `taskId`: deletes the
   * existing `taskId`-linked rules, then creates the new set. A `null` argument
   * means "not provided" and is a no-op (the current reminders are left intact);
   * an empty array clears them. Returns the resulting reminder set (the current
   * rules unchanged on a no-op, else the freshly created rows).
   */
  async replaceForTask(
    taskId: string,
    reminders: ReminderInput[] | null,
  ): Promise<NotificationRule[]> {
    if (reminders === null) {
      return this.listByTask(taskId);
    }

    await this.notificationRuleDatabaseService.delete({ taskId });

    return this.createForTask(taskId, reminders);
  }
}
