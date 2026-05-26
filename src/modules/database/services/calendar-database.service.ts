import { Injectable } from '@nestjs/common';

import { Calendar } from '@/modules/database/entities';
import { CalendarRepository } from '@/modules/database/repositories';
import { BaseDatabaseService } from '@/modules/database/services/base-database.service';

/**
 * Database service for the Calendar entity.
 */
@Injectable()
export class CalendarDatabaseService extends BaseDatabaseService<Calendar> {
  constructor(calendarRepository: CalendarRepository) {
    super(calendarRepository);
  }

  /**
   * Returns all calendars owned by the given user, ordered by `sortOrder`.
   */
  findAllByOwner(ownerId: string) {
    return this.findAll({
      where: { ownerId },
      order: { sortOrder: 'ASC' },
    });
  }
}
