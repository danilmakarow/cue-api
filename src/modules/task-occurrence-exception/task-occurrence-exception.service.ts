import { Injectable } from '@nestjs/common';

import { TaskOccurrenceExceptionDatabaseService } from '@/modules/database/services';

/**
 * Service handling per-occurrence overrides on recurring tasks.
 * Skeleton — override flows land in later steps.
 */
@Injectable()
export class TaskOccurrenceExceptionService {
  constructor(
    private readonly taskOccurrenceExceptionDatabaseService: TaskOccurrenceExceptionDatabaseService,
  ) {}
}
