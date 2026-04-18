import { Injectable } from '@nestjs/common';

import { RecurrenceRuleDatabaseService } from '@/modules/database/services';

/**
 * Service handling recurrence rules for repeating tasks.
 * Skeleton — expansion helpers land alongside the Task service in later steps.
 */
@Injectable()
export class RecurrenceRuleService {
  constructor(
    private readonly recurrenceRuleDatabaseService: RecurrenceRuleDatabaseService,
  ) {}
}
