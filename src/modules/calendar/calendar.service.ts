import { Injectable } from '@nestjs/common';
import { Transactional } from 'typeorm-transactional';

import { CreateCalendarDto } from './dtos';
import { Calendar } from '@/modules/database/entities';
import { CalendarDatabaseService } from '@/modules/database/services';
import { SyncStateService } from '@/modules/sync/sync-state.service';

/**
 * Service handling calendar CRUD and ordering logic.
 */
@Injectable()
export class CalendarService {
  constructor(
    private readonly calendarDatabaseService: CalendarDatabaseService,
    private readonly syncStateService: SyncStateService,
  ) {}

  /**
   * Creates a new calendar owned by the given user and returns the persisted row.
   * Transactional so the calendar insert and the sync-revision bump commit as a
   * unit.
   */
  @Transactional()
  async create(ownerId: string, dto: CreateCalendarDto): Promise<Calendar> {
    const calendar = await this.calendarDatabaseService.create({
      ownerId,
      name: dto.name,
      color: dto.color ?? null,
      icon: dto.icon ?? null,
    });

    await this.syncStateService.bump(ownerId);

    return calendar;
  }

  /**
   * Lists every calendar owned by the given user, ordered by `sortOrder`.
   */
  async findAllByOwner(ownerId: string): Promise<Calendar[]> {
    return this.calendarDatabaseService.findAllByOwner(ownerId);
  }

  /**
   * Returns the user's primary calendar — the first by `sortOrder` — or null
   * when they own none. The assistant uses this to place an event when no
   * explicit calendar is given.
   */
  async findPrimaryForOwner(ownerId: string): Promise<Calendar | null> {
    const calendars =
      await this.calendarDatabaseService.findAllByOwner(ownerId);

    return calendars[0] ?? null;
  }
}
