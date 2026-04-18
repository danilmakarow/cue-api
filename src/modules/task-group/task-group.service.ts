import { Injectable } from '@nestjs/common';

import { TaskGroupDatabaseService } from '@/modules/database/services';

/**
 * Service handling task-group CRUD and ordering logic.
 * Skeleton — endpoints land in later steps.
 */
@Injectable()
export class TaskGroupService {
  constructor(
    private readonly taskGroupDatabaseService: TaskGroupDatabaseService,
  ) {}
}
