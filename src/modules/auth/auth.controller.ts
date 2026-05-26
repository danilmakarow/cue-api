import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  UseGuards,
} from '@nestjs/common';

import { AuthService } from './auth.service';
import { AppleSignInDto } from './dtos';
import { CurrentUser } from '@/decorators/current-user.decorator';
import { AccessTokenGuard } from '@/guards/access-token.guard';
import { User } from '@/modules/database/entities';

/**
 * Response envelope returned to clients after a successful sign-in.
 * `User` is returned whole; the entity JSON-serializes naturally.
 */
interface AuthResponse {
  accessToken: string;
  user: User;
}

/**
 * Endpoints for authentication and session introspection.
 * `/auth/apple` exchanges an Apple identity token for a Cue JWT.
 * `/auth/me` returns the profile for the bearer of a valid JWT.
 */
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /**
   * Exchanges an Apple identity token (with optional profile data) for a Cue JWT.
   */
  @HttpCode(200)
  @Post('apple')
  signInWithApple(@Body() dto: AppleSignInDto): Promise<AuthResponse> {
    return this.authService.signInWithApple(dto);
  }

  /**
   * Returns the authenticated user's profile.
   */
  @UseGuards(AccessTokenGuard)
  @Get('me')
  me(@CurrentUser() user: User): User {
    return user;
  }
}
