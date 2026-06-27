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
import { ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';

import {
  CreateTaskGroupDto,
  ReorderTaskGroupsDto,
  TaskGroupDTO,
  UpdateTaskGroupDto,
  toTaskGroupDTO,
} from './dtos';
import { TaskGroupService } from './task-group.service';
import { CurrentUser } from '@/decorators/current-user.decorator';
import { AccessTokenGuard } from '@/guards/access-token.guard';
import { User } from '@/modules/database/entities';
import { Swagger } from '@/modules/swagger/decorators/swagger.decorator';
import { IdResponseDto } from '@/modules/swagger/dtos/id-response.dto';

/**
 * Controller exposing REST endpoints for the TaskGroup resource.
 * All routes require a valid JWT via `AccessTokenGuard`.
 */
@ApiTags('Task groups')
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
  @Swagger({
    summary: 'Create a task group inside a calendar.',
    responseDto: TaskGroupDTO,
    responseStatus: 201,
  })
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
  @ApiQuery({
    name: 'calendarId',
    required: false,
    format: 'uuid',
    description: 'Scope to a single calendar; omit for all owned calendars.',
  })
  @Swagger({
    summary: 'List task groups for the current user.',
    responseDto: TaskGroupDTO,
    isResponseArray: true,
    responseStatus: 200,
  })
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
   * Bulk-reorders the current user's task groups in one transactional request,
   * assigning each group a `sortOrder` equal to its index in `groupIds`. Replaces
   * the racy N single-PATCH approach. Declared before `:id` so the literal path is
   * not captured by the param route. Returns the reordered groups in order.
   */
  @Patch('reorder')
  @Swagger({
    summary: 'Bulk-reorder task groups transactionally.',
    responseDto: TaskGroupDTO,
    isResponseArray: true,
    responseStatus: 200,
  })
  async reorder(
    @CurrentUser() user: User,
    @Body() dto: ReorderTaskGroupsDto,
  ): Promise<TaskGroupDTO[]> {
    const groups = await this.taskGroupService.reorder(user.id, dto.groupIds);

    return groups.map(toTaskGroupDTO);
  }

  /**
   * Updates a TaskGroup's mutable fields and/or its default recurrence rule.
   * Returns the updated group as a `TaskGroupDTO`.
   */
  @Patch(':id')
  @ApiParam({ name: 'id', format: 'uuid' })
  @Swagger({
    summary: "Update a task group's fields and/or default recurrence rule.",
    responseDto: TaskGroupDTO,
    responseStatus: 200,
  })
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
      requiresCompletion: dto.requiresCompletion,
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
  @ApiParam({ name: 'id', format: 'uuid' })
  @Swagger({
    summary: 'Delete a task group; responds 200 { id }.',
    responseDto: IdResponseDto,
    responseStatus: 200,
  })
  async remove(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ id: string }> {
    await this.taskGroupService.remove(user.id, id);

    return { id };
  }
}
