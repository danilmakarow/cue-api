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

import {
  CreateTaskGroupDto,
  TaskGroupDTO,
  UpdateTaskGroupDto,
  toTaskGroupDTO,
} from './dtos';
import { TaskGroupService } from './task-group.service';
import { CurrentUser } from '@/decorators/current-user.decorator';
import { AccessTokenGuard } from '@/guards/access-token.guard';
import { User } from '@/modules/database/entities';

/**
 * Controller exposing REST endpoints for the TaskGroup resource.
 * All routes require a valid JWT via `AccessTokenGuard`.
 */
@UseGuards(AccessTokenGuard)
@Controller('task-groups')
export class TaskGroupController {
  constructor(private readonly taskGroupService: TaskGroupService) {}

  /**
   * Creates a new TaskGroup inside the referenced Calendar and returns the
   * persisted row as a `TaskGroupDTO`. The referenced Calendar must belong to the
   * current user.
   */
  @Post()
  async create(
    @CurrentUser() user: User,
    @Body() dto: CreateTaskGroupDto,
  ): Promise<TaskGroupDTO> {
    const group = await this.taskGroupService.create(user.id, dto);

    return toTaskGroupDTO(group);
  }

  /**
   * Returns all TaskGroups for the current user. When `calendarId` is provided,
   * scopes the result to that calendar (ownership asserted); otherwise returns
   * groups across all calendars the user owns.
   */
  @Get()
  async findAll(
    @CurrentUser() user: User,
    @Query('calendarId') calendarId?: string,
  ): Promise<TaskGroupDTO[]> {
    const groups = calendarId
      ? await this.taskGroupService.findAllByCalendar(user.id, calendarId)
      : await this.taskGroupService.findAllForUser(user.id);

    return groups.map(toTaskGroupDTO);
  }

  /**
   * Updates a TaskGroup's mutable fields and/or its default recurrence rule.
   * Returns the updated group as a `TaskGroupDTO`.
   */
  @Patch(':id')
  async update(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTaskGroupDto,
  ): Promise<TaskGroupDTO> {
    const group = await this.taskGroupService.update(user.id, id, {
      name: dto.name,
      color: dto.color,
      icon: dto.icon,
      sortOrder: dto.sortOrder,
      recurrence: dto.recurrence,
    });

    return toTaskGroupDTO(group);
  }

  /**
   * Deletes a TaskGroup by id and returns `{ id }` (200 with a JSON body — NOT
   * 204, so the iOS client can decode the response). Contained tasks are not
   * deleted; their `groupId` is set to null by the FK rule.
   */
  @Delete(':id')
  @HttpCode(200)
  async remove(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ id: string }> {
    await this.taskGroupService.remove(user.id, id);

    return { id };
  }
}
