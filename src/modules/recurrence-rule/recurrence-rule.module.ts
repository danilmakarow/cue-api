import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';

import { RecurrenceRuleService } from './recurrence-rule.service';

/**
 * RecurrenceRule module handling RFC-5545-lite recurrence configuration for tasks.
 */
@Module({
  imports: [DatabaseModule],
  providers: [RecurrenceRuleService],
  exports: [RecurrenceRuleService],
})
export class RecurrenceRuleModule {}
