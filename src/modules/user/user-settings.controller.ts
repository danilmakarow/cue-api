import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import {
  UpdateUserSettingsDto,
  UserSettingsDTO,
  toUserSettingsDTO,
} from './dtos';
import { UserService } from './user.service';
import { CurrentUser } from '@/decorators/current-user.decorator';
import { AccessTokenGuard } from '@/guards/access-token.guard';
import { User } from '@/modules/database/entities';
import { Swagger } from '@/modules/swagger/decorators/swagger.decorator';

/**
 * Controller exposing the signed-in user's mutable account settings the iOS
 * Settings screen reads and writes (currently the IANA `timezone`, previously
 * settable only at sign-in via `POST /auth/apple`). All routes require a valid
 * JWT via `AccessTokenGuard` and operate on the current user (`/users/me/...`).
 */
@ApiTags('Users')
@UseGuards(AccessTokenGuard)
@Controller('users/me/settings')
export class UserSettingsController {
  constructor(private readonly userService: UserService) {}

  /**
   * Returns the current user's account settings (their persisted timezone).
   */
  @Get()
  @Swagger({
    summary: 'Get the current user account settings.',
    responseDto: UserSettingsDTO,
    responseStatus: 200,
  })
  get(@CurrentUser() user: User): UserSettingsDTO {
    return toUserSettingsDTO(user);
  }

  /**
   * Updates the current user's account settings — timezone (validated as a real
   * IANA zone), display name, avatar, and notification opt-ins. Returns the
   * persisted shape.
   */
  @Patch()
  @Swagger({
    summary:
      'Update the current user account settings (timezone, displayName, avatar, notification prefs).',
    responseDto: UserSettingsDTO,
    responseStatus: 200,
  })
  async update(
    @CurrentUser() user: User,
    @Body() dto: UpdateUserSettingsDto,
  ): Promise<UserSettingsDTO> {
    const updated = await this.userService.updateSettings(user.id, dto);

    return toUserSettingsDTO(updated);
  }
}
