import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiParam, ApiTags } from '@nestjs/swagger';

import {
  ChangesDTO,
  ChangesQuery,
  CompletionResultDTO,
  DailyCountsDTO,
  DailyCountsQuery,
  ListTasksQuery,
  OccurrenceDTO,
  SetCompletionDto,
  SkipOccurrenceDto,
  TaskDTO,
  UpdateTaskDto,
  toOccurrenceDTO,
  toTaskDTO,
  toTaskOccurrenceExceptionDTO,
} from './dtos';
import { CreateTaskDto } from './dtos';
import { TaskService } from './task.service';
import { CurrentUser } from '@/decorators/current-user.decorator';
import { AccessTokenGuard } from '@/guards/access-token.guard';
import { User } from '@/modules/database/entities';
import { Swagger } from '@/modules/swagger/decorators/swagger.decorator';
import { IdResponseDto } from '@/modules/swagger/dtos/id-response.dto';
import { OkResponseDto } from '@/modules/swagger/dtos/ok-response.dto';

/**
 * Controller exposing REST endpoints for the Task resource.
 * All routes require a valid JWT via `AccessTokenGuard`.
 */
@ApiTags('Tasks')
@UseGuards(AccessTokenGuard)
@Controller('tasks')
export class TaskController {
  constructor(private readonly taskService: TaskService) {}

  /**
   * Returns expanded occurrences intersecting `[from, to)` for the given
   * calendar, merging one-off tasks and recurring-anchor expansions. Replaces
   * the previous raw-row GET.
   */
  @Get()
  @Swagger({
    summary: 'List expanded task occurrences in a [from, to) window.',
    responseDto: OccurrenceDTO,
    isResponseArray: true,
    responseStatus: 200,
  })
  async list(
    @CurrentUser() user: User,
    @Query() query: ListTasksQuery,
  ): Promise<OccurrenceDTO[]> {
    const occurrences = await this.taskService.findOccurrencesInRange(
      user.id,
      new Date(query.from),
      new Date(query.to),
      {
        calendarId: query.calendarId,
        includeCompleted: query.includeCompleted,
        includeTodos: query.includeTodos,
      },
    );

    return occurrences.map(toOccurrenceDTO);
  }

  /**
   * Returns per-day occurrence counts for the given calendar over `[from, to)`.
   * Declared before `@Get(':id')` so the literal `daily-counts` path is matched
   * ahead of the parametric id route.
   */
  @Get('daily-counts')
  @Swagger({
    summary: 'Get per-day task occurrence counts in a [from, to) window.',
    responseDto: DailyCountsDTO,
    responseStatus: 200,
  })
  async getDailyCounts(
    @CurrentUser() user: User,
    @Query() query: DailyCountsQuery,
  ): Promise<DailyCountsDTO> {
    const counts = await this.taskService.getDailyCounts(
      user.id,
      new Date(query.from),
      new Date(query.to),
      {
        calendarId: query.calendarId,
        includeCompleted: query.includeCompleted,
      },
    );

    return { counts };
  }

  /**
   * Returns the precise change-delta for a calendar since the opaque cursor
   * `since` (the previous response's `serverTime`). Declared before `@Get(':id')`
   * so the literal `changes` path is matched ahead of the parametric id route.
   * On the first call `since` is omitted — the response carries empty sets and
   * only the cursor, letting the client fall back to full per-window SWR.
   */
  @Get('changes')
  @Swagger({
    summary: 'Get changed/deleted series + exceptions since an opaque cursor.',
    responseDto: ChangesDTO,
    responseStatus: 200,
  })
  async getChanges(
    @CurrentUser() user: User,
    @Query() query: ChangesQuery,
  ): Promise<ChangesDTO> {
    const delta = await this.taskService.findChangedSince(
      user.id,
      query.since ? new Date(query.since) : null,
      query.calendarId,
      { includeTodos: query.includeTodos },
    );

    return {
      tasks: delta.tasks.map(toTaskDTO),
      deleted: delta.deleted,
      exceptions: delta.exceptions.map(toTaskOccurrenceExceptionDTO),
      serverTime: delta.serverTime.toISOString(),
    };
  }

  /**
   * Returns the Task series row by id (with its recurrence rule embedded).
   */
  @Get(':id')
  @ApiParam({ name: 'id', format: 'uuid' })
  @Swagger({
    summary: 'Get a task series row (with its recurrence rule).',
    responseDto: TaskDTO,
    responseStatus: 200,
  })
  async findOne(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<TaskDTO> {
    const task = await this.taskService.findByIdWithRule(user.id, id);

    return toTaskDTO(task);
  }

  /**
   * Creates a new Task inside the referenced Calendar and returns the persisted
   * row as a `TaskDTO`. The referenced Calendar must belong to the current user.
   */
  @Post()
  @Swagger({
    summary: 'Create a task (optionally recurring) inside a calendar.',
    responseDto: TaskDTO,
    responseStatus: 201,
  })
  async create(
    @CurrentUser() user: User,
    @Body() dto: CreateTaskDto,
  ): Promise<TaskDTO> {
    const task = await this.taskService.create(user.id, dto);

    // Re-load with the rule relation so the recurrence field is populated.
    const taskWithRule = await this.taskService.findByIdWithRule(
      user.id,
      task.id,
    );

    return toTaskDTO(taskWithRule);
  }

  /**
   * Updates the Task in the "all" / one-off scope: title, notes, time window,
   * group, isAllDay, requiresCompletion, and the master recurrence rule.
   */
  @Patch(':id')
  @ApiParam({ name: 'id', format: 'uuid' })
  @Swagger({
    summary: 'Update a task in the all / one-off scope.',
    responseDto: TaskDTO,
    responseStatus: 200,
  })
  async update(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTaskDto,
  ): Promise<TaskDTO> {
    const task = await this.taskService.update(user.id, id, {
      title: dto.title,
      notes: dto.notes,
      startAt: dto.startAt,
      endAt: dto.endAt,
      isAllDay: dto.isAllDay,
      requiresCompletion: dto.requiresCompletion,
      groupId: dto.groupId,
      recurrence: dto.recurrence,
    });

    // Re-load to get the rule relation if it was just added.
    const taskWithRule = await this.taskService.findByIdWithRule(
      user.id,
      task.id,
    );

    return toTaskDTO(taskWithRule);
  }

  /**
   * Soft-deletes the Task and returns `{ id }` (200 with a JSON body — NOT 204,
   * so the iOS client can decode the response).
   */
  @Delete(':id')
  @HttpCode(200)
  @ApiParam({ name: 'id', format: 'uuid' })
  @Swagger({
    summary: 'Soft-delete a task; responds 200 { id }.',
    responseDto: IdResponseDto,
    responseStatus: 200,
  })
  async remove(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ id: string }> {
    await this.taskService.remove(user.id, id);

    return { id };
  }

  /**
   * Toggles completion of a task or a single occurrence of a recurring task.
   * When `occurrenceStart` is present, only that instance is toggled;
   * otherwise the series anchor (or one-off task) is toggled. Ownership is
   * asserted on both branches before any write.
   */
  @Patch(':id/completion')
  @ApiParam({ name: 'id', format: 'uuid' })
  @Swagger({
    summary: 'Toggle completion of a task or a single occurrence.',
    responseDto: CompletionResultDTO,
    responseStatus: 200,
  })
  async setCompletion(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetCompletionDto,
  ): Promise<CompletionResultDTO> {
    if (dto.occurrenceStart) {
      const result = await this.taskService.setOccurrenceCompleted(
        user.id,
        id,
        new Date(dto.occurrenceStart),
        dto.isCompleted,
      );

      return {
        taskId: id,
        // A non-recurring task hitting this branch collapses to a master toggle,
        // so report no occurrence to match what was actually persisted.
        occurrenceStart: result.isOccurrenceScoped ? dto.occurrenceStart : null,
        completedAt: result.completedAt
          ? result.completedAt.toISOString()
          : null,
      };
    }

    // Assert calendar ownership before toggling — `setCompleted` itself does
    // not (it is a bare `findOneBy({ id })`), so calling it directly would let
    // any authenticated user toggle another user's task by id.
    const task = await this.taskService.findById(user.id, id);
    const updated = await this.taskService.setCompleted(
      task.id,
      dto.isCompleted,
    );

    return {
      taskId: updated.id,
      occurrenceStart: null,
      completedAt: updated.completedAt
        ? updated.completedAt.toISOString()
        : null,
    };
  }

  /**
   * Skips a single occurrence of a recurring task by upserting a
   * `TaskOccurrenceException` with `isSkipped: true`.
   */
  @Post(':id/skip')
  @ApiParam({ name: 'id', format: 'uuid' })
  @Swagger({
    summary: 'Skip a single occurrence of a recurring task.',
    responseDto: OkResponseDto,
    responseStatus: 201,
  })
  async skipOccurrence(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SkipOccurrenceDto,
  ): Promise<{ ok: true }> {
    await this.taskService.applyOccurrenceOverride(
      user.id,
      id,
      new Date(dto.occurrenceStart),
      { isSkipped: true },
    );

    return { ok: true };
  }
}
