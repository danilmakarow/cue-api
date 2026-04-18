import { Module } from '@nestjs/common';

import { RecurrenceRuleService } from './recurrence-rule.service';
import { DatabaseModule } from '../database/database.module';

/**
 * RecurrenceRule module handling RFC-5545-lite recurrence configuration for tasks.
 */
@Module({
  imports: [DatabaseModule],
  providers: [RecurrenceRuleService],
  exports: [RecurrenceRuleService],
})
export class RecurrenceRuleModule {}
