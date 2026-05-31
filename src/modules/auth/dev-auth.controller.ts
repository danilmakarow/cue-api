import {
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';

import { AuthenticationResult, AuthService } from './auth.service';

import { DevOnlyGuard } from '@/guards/dev-only.guard';
import { User } from '@/modules/database/entities';
import { UserDatabaseService } from '@/modules/database/services';

/**
 * Development-only authentication helpers — list every user and impersonate
 * one by id. The `DevOnlyGuard` returns 404 outside `NODE_ENV=development`,
 * so these handlers are invisible in any other environment.
 */
@UseGuards(DevOnlyGuard)
@Controller('auth/dev')
export class DevAuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly userDatabaseService: UserDatabaseService,
  ) {}

  /**
   * Returns every user in the database. Intended for the iOS dev-login picker.
   */
  @Get('users')
  listUsers(): Promise<User[]> {
    return this.userDatabaseService.findAll({ order: { createdAt: 'DESC' } });
  }

  /**
   * Issues a JWT for the given user without any credential check. The
   * response mirrors `POST /auth/apple` so the iOS client can reuse the
   * same handling path.
   */
  @HttpCode(200)
  @Post('login/:userId')
  async loginAs(
    @Param('userId', new ParseUUIDPipe()) userId: string,
  ): Promise<AuthenticationResult> {
    const user = await this.userDatabaseService.findOneBy({ id: userId });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const accessToken = await this.authService.issueTokenForUser(user);

    return { accessToken, user };
  }
}
