import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { AuthService } from './auth.service';
import { AppleSignInDto, AuthResponseDto } from './dtos';
import { CurrentUser } from '@/decorators/current-user.decorator';
import { AccessTokenGuard } from '@/guards/access-token.guard';
import { User } from '@/modules/database/entities';
import { Swagger } from '@/modules/swagger/decorators/swagger.decorator';

/**
 * Endpoints for authentication and session introspection.
 * `/auth/apple` exchanges an Apple identity token for a Cue JWT.
 * `/auth/me` returns the profile for the bearer of a valid JWT.
 */
@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /**
   * Exchanges an Apple identity token (with optional profile data) for a Cue JWT.
   */
  @HttpCode(200)
  @Post('apple')
  @Swagger({
    summary: 'Exchange an Apple identity token for a Cue JWT.',
    responseDto: AuthResponseDto,
    responseStatus: 200,
    responseDescription: 'Issued JWT and the resolved user.',
    disableAuth: true,
  })
  signInWithApple(@Body() dto: AppleSignInDto): Promise<AuthResponseDto> {
    return this.authService.signInWithApple(dto);
  }

  /**
   * Returns the authenticated user's profile.
   */
  @UseGuards(AccessTokenGuard)
  @Get('me')
  @Swagger({
    summary: "Get the authenticated user's profile.",
    responseDto: User,
    responseStatus: 200,
  })
  me(@CurrentUser() user: User): User {
    return user;
  }
}
