import { Injectable } from '@nestjs/common';

import { RecurrenceRule } from '@/modules/database/entities';
import { RecurrenceRuleRepository } from '@/modules/database/repositories';
import { BaseDatabaseService } from '@/modules/database/services/base-database.service';

/**
 * Database service for the RecurrenceRule entity.
 */
@Injectable()
export class RecurrenceRuleDatabaseService extends BaseDatabaseService<RecurrenceRule> {
  constructor(recurrenceRuleRepository: RecurrenceRuleRepository) {
    super(recurrenceRuleRepository);
  }
}
