import {
  Body,
  Controller,
  Delete,
  Get,
  Patch,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { BriefSettingsService } from './brief-settings.service';
import {
  BriefSettingsDTO,
  UpdateBriefSettingsDto,
  toBriefSettingsDTO,
} from './dtos';
import { CurrentUser } from '@/decorators/current-user.decorator';
import { AccessTokenGuard } from '@/guards/access-token.guard';
import { User } from '@/modules/database/entities';
import { Swagger } from '@/modules/swagger/decorators/swagger.decorator';

/**
 * Controller exposing the per-user daily-brief personalization settings the iOS
 * Settings screen reads and writes (`customPrompt`). All routes require a valid
 * JWT via `AccessTokenGuard` and operate on the current user (`/users/me/...`).
 *
 * A PATCH or DELETE invalidates today's cached brief for the user so the changed
 * prompt takes effect on the next `GET /users/me/daily-brief` read.
 */
@ApiTags('Users')
@UseGuards(AccessTokenGuard)
@Controller('users/me/brief-settings')
export class BriefSettingsController {
  constructor(private readonly briefSettingsService: BriefSettingsService) {}

  /**
   * Returns the current user's daily-brief settings, creating a default
   * (null `customPrompt`) on the first read.
   */
  @Get()
  @Swagger({
    summary:
      'Get the current user daily-brief settings (creates a default; customPrompt null when unset).',
    responseDto: BriefSettingsDTO,
    responseStatus: 200,
  })
  async get(@CurrentUser() user: User): Promise<BriefSettingsDTO> {
    const settings = await this.briefSettingsService.getOrCreate(user.id);

    return toBriefSettingsDTO(settings);
  }

  /**
   * Updates the current user's custom brief prompt (a non-empty string sets it,
   * null clears it), invalidates today's cached brief, and returns the persisted
   * shape.
   */
  @Patch()
  @Swagger({
    summary: 'Update the current user custom daily-brief prompt.',
    responseDto: BriefSettingsDTO,
    responseStatus: 200,
  })
  async update(
    @CurrentUser() user: User,
    @Body() dto: UpdateBriefSettingsDto,
  ): Promise<BriefSettingsDTO> {
    const settings = await this.briefSettingsService.update(user, dto);

    return toBriefSettingsDTO(settings);
  }

  /**
   * Resets the current user's brief settings to the default by clearing
   * `customPrompt`, invalidates today's cached brief, and returns the now-cleared
   * shape (`customPrompt: null`). Idempotent.
   */
  @Delete()
  @Swagger({
    summary:
      'Reset the current user daily-brief settings to default (clears customPrompt; idempotent).',
    responseDto: BriefSettingsDTO,
    responseStatus: 200,
  })
  async reset(@CurrentUser() user: User): Promise<BriefSettingsDTO> {
    const settings = await this.briefSettingsService.reset(user);

    return toBriefSettingsDTO(settings);
  }
}
