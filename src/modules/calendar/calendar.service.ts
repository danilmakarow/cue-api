import { Injectable } from '@nestjs/common';

import { CreateCalendarDto } from './dtos';

import { Calendar } from '@/modules/database/entities';
import { CalendarDatabaseService } from '@/modules/database/services';

/**
 * Service handling calendar CRUD and ordering logic.
 */
@Injectable()
export class CalendarService {
  constructor(
    private readonly calendarDatabaseService: CalendarDatabaseService,
  ) {}

  /**
   * Creates a new calendar owned by the given user and returns the persisted row.
   */
  async create(ownerId: string, dto: CreateCalendarDto): Promise<Calendar> {
    return this.calendarDatabaseService.create({
      ownerId,
      name: dto.name,
      color: dto.color ?? null,
      icon: dto.icon ?? null,
    });
  }

  /**
   * Lists every calendar owned by the given user, ordered by `sortOrder`.
   */
  async findAllByOwner(ownerId: string): Promise<Calendar[]> {
    return this.calendarDatabaseService.findAllByOwner(ownerId);
  }
}
