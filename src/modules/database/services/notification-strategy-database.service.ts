import { Injectable } from '@nestjs/common';

import { NotificationStrategy } from '@/modules/database/entities';
import { NotificationStrategyRepository } from '@/modules/database/repositories';
import { BaseDatabaseService } from '@/modules/database/services/base-database.service';

/**
 * Database service for the NotificationStrategy entity.
 */
@Injectable()
export class NotificationStrategyDatabaseService extends BaseDatabaseService<NotificationStrategy> {
  constructor(notificationStrategyRepository: NotificationStrategyRepository) {
    super(notificationStrategyRepository);
  }
}
