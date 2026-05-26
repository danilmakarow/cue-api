import { Injectable } from '@nestjs/common';

import { TaskGroup } from '@/modules/database/entities';
import { TaskGroupRepository } from '@/modules/database/repositories';
import { BaseDatabaseService } from '@/modules/database/services/base-database.service';

/**
 * Database service for the TaskGroup entity.
 */
@Injectable()
export class TaskGroupDatabaseService extends BaseDatabaseService<TaskGroup> {
  constructor(taskGroupRepository: TaskGroupRepository) {
    super(taskGroupRepository);
  }

  /**
   * Returns all task groups that belong to the given calendar, ordered by `sortOrder`.
   */
  findAllByCalendar(calendarId: string) {
    return this.findAll({
      where: { calendarId },
      order: { sortOrder: 'ASC' },
    });
  }
}
