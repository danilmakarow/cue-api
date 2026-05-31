import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';

import { NotificationRuleService } from './notification-rule.service';

/**
 * NotificationRule module managing atomic alert-offset entries that compose a strategy.
 */
@Module({
  imports: [DatabaseModule],
  providers: [NotificationRuleService],
  exports: [NotificationRuleService],
})
export class NotificationRuleModule {}
