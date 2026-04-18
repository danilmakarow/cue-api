import { Injectable } from '@nestjs/common';

import { ScheduledNotificationDatabaseService } from '@/modules/database/services';

/**
 * Service operating the ScheduledNotification outbox — enqueueing, claiming, and recording delivery.
 * Skeleton — the delivery worker and retry logic land in later steps.
 */
@Injectable()
export class ScheduledNotificationService {
  constructor(
    private readonly scheduledNotificationDatabaseService: ScheduledNotificationDatabaseService,
  ) {}
}
