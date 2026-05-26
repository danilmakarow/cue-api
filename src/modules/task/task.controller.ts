import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';

import { CreateTaskDto, ListTasksQuery, SetTaskCompletedDto } from './dtos';
import { TaskService } from './task.service';
import { CurrentUser } from '@/decorators/current-user.decorator';
import { AccessTokenGuard } from '@/guards/access-token.guard';
import { Task, User } from '@/modules/database/entities';

/**
 * Controller exposing REST endpoints for the Task resource.
 * All routes require a valid JWT via `AccessTokenGuard`.
 */
@UseGuards(AccessTokenGuard)
@Controller('tasks')
export class TaskController {
  constructor(private readonly taskService: TaskService) {}

  /**
   * Creates a new Task inside the referenced Calendar and returns the persisted row.
   * The referenced Calendar must belong to the current user.
   */
  @Post()
  create(@CurrentUser() user: User, @Body() dto: CreateTaskDto): Promise<Task> {
    return this.taskService.create(user.id, dto);
  }

  /**
   * Lists Tasks in the given Calendar whose `startAt` falls in `[from, to)`,
   * ordered by `startAt` ascending. Powers the iOS day-schedule view.
   */
  @Get()
  list(
    @CurrentUser() user: User,
    @Query() query: ListTasksQuery,
  ): Promise<Task[]> {
    return this.taskService.findInRange(
      user.id,
      query.calendarId,
      new Date(query.from),
      new Date(query.to),
    );
  }

  /**
   * Toggles the completion state of the Task identified by `id`.
   * Sets `completedAt` to the current time when `isCompleted` is true
   * (idempotent — keeps the existing timestamp if already set) and clears
   * it when false. Returns the updated Task.
   */
  @Patch(':id')
  setCompleted(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetTaskCompletedDto,
  ): Promise<Task> {
    return this.taskService.setCompleted(id, dto.isCompleted);
  }
}
