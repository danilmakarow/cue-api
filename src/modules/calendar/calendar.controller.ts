import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { CalendarService } from './calendar.service';
import { CreateCalendarDto } from './dtos';
import { CurrentUser } from '@/decorators/current-user.decorator';
import { AccessTokenGuard } from '@/guards/access-token.guard';
import { Calendar, User } from '@/modules/database/entities';
import { Swagger } from '@/modules/swagger/decorators/swagger.decorator';

/**
 * Controller exposing REST endpoints for the Calendar resource.
 * All routes require a valid JWT via `AccessTokenGuard`.
 */
@ApiTags('Calendars')
@UseGuards(AccessTokenGuard)
@Controller('calendars')
export class CalendarController {
  constructor(private readonly calendarService: CalendarService) {}

  /**
   * Creates a new Calendar for the current user and returns the persisted row.
   */
  @Post()
  @Swagger({
    summary: 'Create a calendar for the current user.',
    responseDto: Calendar,
    responseStatus: 201,
  })
  create(
    @CurrentUser() user: User,
    @Body() dto: CreateCalendarDto,
  ): Promise<Calendar> {
    return this.calendarService.create(user.id, dto);
  }

  /**
   * Returns every Calendar owned by the current user.
   */
  @Get()
  @Swagger({
    summary: 'List the calendars owned by the current user.',
    responseDto: Calendar,
    isResponseArray: true,
    responseStatus: 200,
  })
  findAll(@CurrentUser() user: User): Promise<Calendar[]> {
    return this.calendarService.findAllByOwner(user.id);
  }
}
