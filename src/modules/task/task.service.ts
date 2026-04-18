import { Injectable } from '@nestjs/common';

import { TaskDatabaseService } from '@/modules/database/services';

/**
 * Service handling Task CRUD, completion, and recurrence expansion.
 * Skeleton — endpoints and occurrence planning land in later steps.
 */
@Injectable()
export class TaskService {
  constructor(private readonly taskDatabaseService: TaskDatabaseService) {}
}
