import { Controller, Delete, HttpCode, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { UserService } from './user.service';
import { CurrentUser } from '@/decorators/current-user.decorator';
import { AccessTokenGuard } from '@/guards/access-token.guard';
import { User } from '@/modules/database/entities';
import { Swagger } from '@/modules/swagger/decorators/swagger.decorator';
import { OkResponseDto } from '@/modules/swagger/dtos/ok-response.dto';

/**
 * Controller for whole-account operations on the signed-in user (`/users/me`),
 * distinct from the settings surface at `/users/me/settings`. Currently exposes
 * account deletion (S5). All routes require a valid JWT via `AccessTokenGuard`.
 */
@ApiTags('Users')
@UseGuards(AccessTokenGuard)
@Controller('users/me')
export class UserAccountController {
  constructor(private readonly userService: UserService) {}

  /**
   * Permanently deletes the signed-in user's account: cascade-purges the user
   * aggregate and revokes the Apple refresh token (Sign-in-with-Apple
   * account-deletion policy). Responds 200 `{ ok: true }`.
   */
  @Delete()
  @HttpCode(200)
  @Swagger({
    summary:
      'Delete the signed-in user account (cascade purge + Apple revoke).',
    responseDto: OkResponseDto,
    responseStatus: 200,
  })
  async delete(@CurrentUser() user: User): Promise<OkResponseDto> {
    await this.userService.deleteAccount(user.id);

    return { ok: true };
  }
}
