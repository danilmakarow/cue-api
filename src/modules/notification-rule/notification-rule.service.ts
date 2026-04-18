import { Injectable } from '@nestjs/common';

import { NotificationRuleDatabaseService } from '@/modules/database/services';

/**
 * Service handling individual notification rules inside a strategy.
 * Skeleton — CRUD lands in later steps.
 */
@Injectable()
export class NotificationRuleService {
  constructor(
    private readonly notificationRuleDatabaseService: NotificationRuleDatabaseService,
  ) {}
}
