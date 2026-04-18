import { Injectable } from '@nestjs/common';

import { NotificationRule } from '@/modules/database/entities';
import { NotificationRuleRepository } from '@/modules/database/repositories';
import { BaseDatabaseService } from '@/modules/database/services/base-database.service';

/**
 * Database service for the NotificationRule entity.
 */
@Injectable()
export class NotificationRuleDatabaseService extends BaseDatabaseService<NotificationRule> {
  constructor(notificationRuleRepository: NotificationRuleRepository) {
    super(notificationRuleRepository);
  }
}
