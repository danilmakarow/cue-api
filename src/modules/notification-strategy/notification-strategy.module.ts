import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';

import { NotificationStrategyService } from './notification-strategy.service';

/**
 * NotificationStrategy module managing named bundles of notification rules.
 */
@Module({
  imports: [DatabaseModule],
  providers: [NotificationStrategyService],
  exports: [NotificationStrategyService],
})
export class NotificationStrategyModule {}
