import { Module } from '@nestjs/common';

import { NotificationRuleService } from './notification-rule.service';
import { DatabaseModule } from '../database/database.module';

/**
 * NotificationRule module managing atomic alert-offset entries that compose a strategy.
 */
@Module({
  imports: [DatabaseModule],
  providers: [NotificationRuleService],
  exports: [NotificationRuleService],
})
export class NotificationRuleModule {}
