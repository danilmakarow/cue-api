import { Injectable } from '@nestjs/common';

import { NotificationStrategyDatabaseService } from '@/modules/database/services';

/**
 * Service handling notification strategies (bundles of rules).
 * Skeleton — CRUD and attach-to-task endpoints land in later steps.
 */
@Injectable()
export class NotificationStrategyService {
  constructor(
    private readonly notificationStrategyDatabaseService: NotificationStrategyDatabaseService,
  ) {}
}
