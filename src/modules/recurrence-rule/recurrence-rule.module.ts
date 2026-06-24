import { Module } from '@nestjs/common';

import { RecurrenceRuleService } from './recurrence-rule.service';

/**
 * RecurrenceRule module exposing the pure RFC-5545-lite recurrence expansion
 * engine. Recurrence is stored inline on Task / TaskGroup rows (ADR 0054), so the
 * engine carries no database dependency.
 */
@Module({
  providers: [RecurrenceRuleService],
  exports: [RecurrenceRuleService],
})
export class RecurrenceRuleModule {}
