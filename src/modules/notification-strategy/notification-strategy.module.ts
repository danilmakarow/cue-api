import { Module } from '@nestjs/common';

import { NotificationStrategyService } from './notification-strategy.service';
import { DatabaseModule } from '../database/database.module';

/**
 * NotificationStrategy module managing named bundles of notification rules.
 */
@Module({
  imports: [DatabaseModule],
  providers: [NotificationStrategyService],
  exports: [NotificationStrategyService],
})
export class NotificationStrategyModule {}
