import { Injectable } from '@nestjs/common';

import { TaskOccurrenceException } from '@/modules/database/entities';
import { TaskOccurrenceExceptionRepository } from '@/modules/database/repositories';
import { BaseDatabaseService } from '@/modules/database/services/base-database.service';

/**
 * Database service for the TaskOccurrenceException entity.
 */
@Injectable()
export class TaskOccurrenceExceptionDatabaseService extends BaseDatabaseService<TaskOccurrenceException> {
  constructor(
    taskOccurrenceExceptionRepository: TaskOccurrenceExceptionRepository,
  ) {
    super(taskOccurrenceExceptionRepository);
  }
}
