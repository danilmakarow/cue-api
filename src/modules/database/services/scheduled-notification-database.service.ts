import { Injectable } from '@nestjs/common';
import { LessThanOrEqual } from 'typeorm';

import {
  ScheduledNotification,
  ScheduledNotificationStatus,
} from '@/modules/database/entities';
import { ScheduledNotificationRepository } from '@/modules/database/repositories';
import { BaseDatabaseService } from '@/modules/database/services/base-database.service';

/**
 * Database service for the ScheduledNotification entity.
 * Provides queue-style helpers used by the notification worker.
 */
@Injectable()
export class ScheduledNotificationDatabaseService extends BaseDatabaseService<ScheduledNotification> {
  constructor(
    scheduledNotificationRepository: ScheduledNotificationRepository,
  ) {
    super(scheduledNotificationRepository);
  }

  /**
   * Returns pending notifications whose `fireAt` is on or before the provided timestamp,
   * up to the given limit. Used by the delivery worker to claim work.
   */
  findDueNotifications(now: Date, limit: number) {
    return this.findAll({
      where: {
        status: ScheduledNotificationStatus.PENDING,
        fireAt: LessThanOrEqual(now),
      },
      order: { fireAt: 'ASC' },
      take: limit,
    });
  }
}
