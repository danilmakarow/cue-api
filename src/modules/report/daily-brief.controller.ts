import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { DailyBriefService } from './daily-brief.service';
import { DailyBriefDTO, DailyBriefQuery } from './dtos';
import { CurrentUser } from '@/decorators/current-user.decorator';
import { AccessTokenGuard } from '@/guards/access-token.guard';
import { User } from '@/modules/database/entities';
import { Swagger } from '@/modules/swagger/decorators/swagger.decorator';

/**
 * Controller exposing the on-demand morning daily brief (backlog D2) the iOS
 * today card reads. It surfaces the otherwise scheduler-only report generator as
 * a GET, with a per-user-per-local-day cache bounding the MAIN-model cost. All
 * routes require a valid JWT via `AccessTokenGuard` and operate on the current
 * user (`/users/me/...`).
 */
@ApiTags('Users')
@UseGuards(AccessTokenGuard)
@Controller('users/me/daily-brief')
export class DailyBriefController {
  constructor(private readonly dailyBriefService: DailyBriefService) {}

  /**
   * Returns the daily brief for the current user on the given local `date`
   * (`YYYY-MM-DD`, user timezone) — or today's when omitted. Served from a 24h
   * per-day cache; a miss runs ONE MAIN-model generation and caches it. `brief`
   * is null when the day yielded nothing usable. `refresh=true` bypasses the
   * cache read, regenerates, and overwrites the cached value.
   */
  @Get()
  @Swagger({
    summary:
      'Get the current user daily brief for a local day (cached per day; refresh=true regenerates; on-demand MAIN-model call).',
    responseDto: DailyBriefDTO,
    queryParamsDto: DailyBriefQuery,
    responseStatus: 200,
  })
  async get(
    @CurrentUser() user: User,
    @Query() query: DailyBriefQuery,
  ): Promise<DailyBriefDTO> {
    const { brief, localDate } = await this.dailyBriefService.getBrief(
      user,
      query.date,
      query.refresh,
    );

    return { brief, localDate };
  }
}
