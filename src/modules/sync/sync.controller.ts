import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { SyncStateDto } from './dtos';
import { SyncStateService } from './sync-state.service';
import { CurrentUser } from '@/decorators/current-user.decorator';
import { AccessTokenGuard } from '@/guards/access-token.guard';
import { User } from '@/modules/database/entities';
import { Swagger } from '@/modules/swagger/decorators/swagger.decorator';

/**
 * Controller exposing the cheap sync-state check. All routes require a valid JWT
 * via `AccessTokenGuard`.
 */
@ApiTags('Sync')
@UseGuards(AccessTokenGuard)
@Controller('sync')
export class SyncController {
  constructor(private readonly syncStateService: SyncStateService) {}

  /**
   * Returns the current user's monotonic sync revision plus server time. The
   * client compares `revision` to its last-seen value to decide whether to pull
   * the delta — a single PK lookup, deliberately cheaper than a real sync.
   */
  @Get('state')
  @Swagger({
    summary: 'Cheap per-user "did anything change?" sync check.',
    responseDto: SyncStateDto,
    responseStatus: 200,
  })
  getState(@CurrentUser() user: User): Promise<SyncStateDto> {
    return this.syncStateService.getState(user.id);
  }
}
