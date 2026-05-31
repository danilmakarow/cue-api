import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { And, LessThan, MoreThanOrEqual } from 'typeorm';

import { CreateTaskDto } from './dtos';

import { EntityNotFoundException } from '@/exceptions/entity-not-found.exception';
import { Calendar, Task } from '@/modules/database/entities';
import {
  CalendarDatabaseService,
  TaskDatabaseService,
} from '@/modules/database/services';

/**
 * Service handling Task CRUD, completion, and recurrence expansion.
 */
@Injectable()
export class TaskService {
  constructor(
    private readonly taskDatabaseService: TaskDatabaseService,
    private readonly calendarDatabaseService: CalendarDatabaseService,
  ) {}

  /**
   * Creates a new Task inside the Calendar identified by `dto.calendarId`.
   * Throws 404 when the calendar is missing, 403 when it belongs to another user,
   * and 400 when `endAt` precedes `startAt`.
   */
  async create(userId: string, dto: CreateTaskDto): Promise<Task> {
    await this.ensureCalendarOwnedByUser(dto.calendarId, userId);

    const startAt = dto.startAt ? new Date(dto.startAt) : null;
    const endAt = dto.endAt ? new Date(dto.endAt) : null;

    if (startAt && endAt && endAt.getTime() < startAt.getTime()) {
      throw new BadRequestException(
        'endAt must be greater than or equal to startAt',
      );
    }

    return this.taskDatabaseService.create({
      calendarId: dto.calendarId,
      title: dto.title,
      notes: dto.notes ?? null,
      startAt,
      endAt,
      isAllDay: dto.isAllDay ?? false,
      timezone: dto.timezone,
      requiresCompletion: dto.requiresCompletion ?? true,
    });
  }

  /**
   * Lists Tasks in the given Calendar whose `startAt` falls in the half-open
   * window `[from, to)`, ordered by `startAt` ascending.
   * Throws 404 when the calendar does not exist, 403 when it belongs to another
   * user, and 400 when the window is empty.
   */
  async findInRange(
    userId: string,
    calendarId: string,
    from: Date,
    to: Date,
  ): Promise<Task[]> {
    if (from.getTime() >= to.getTime()) {
      throw new BadRequestException('`to` must be greater than `from`');
    }

    await this.ensureCalendarOwnedByUser(calendarId, userId);

    return this.taskDatabaseService.findAll({
      where: {
        calendarId,
        startAt: And(MoreThanOrEqual(from), LessThan(to)),
      },
      order: { startAt: 'ASC' },
    });
  }

  /**
   * Toggles the Task's completion state by id.
   * When `isCompleted` is true, stamps `completedAt = new Date()` only if
   * not already set (idempotent). When false, clears `completedAt`.
   * Throws 404 when the task does not exist.
   */
  async setCompleted(id: string, isCompleted: boolean): Promise<Task> {
    const task = await this.taskDatabaseService.findOneBy({ id });

    if (!task) {
      throw new EntityNotFoundException(Task);
    }

    if (isCompleted) {
      if (task.completedAt) {
        return task;
      }

      task.completedAt = new Date();

      return this.taskDatabaseService.save(task);
    }

    if (task.completedAt === null) {
      return task;
    }

    task.completedAt = null;

    return this.taskDatabaseService.save(task);
  }

  /**
   * Loads the calendar and asserts the given user owns it.
   * Throws 404 when missing, 403 when owned by someone else.
   */
  private async ensureCalendarOwnedByUser(
    calendarId: string,
    userId: string,
  ): Promise<void> {
    const calendar = await this.calendarDatabaseService.findOneBy({
      id: calendarId,
    });

    if (!calendar) {
      throw new EntityNotFoundException(Calendar);
    }

    if (calendar.ownerId !== userId) {
      throw new ForbiddenException('You do not have access to this calendar');
    }
  }
}
