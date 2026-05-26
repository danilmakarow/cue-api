import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';

import { AccessTokenPayload } from '@/modules/auth/auth.service';
import { User } from '@/modules/database/entities';
import { UserDatabaseService } from '@/modules/database/services';

/**
 * Request augmented with the authenticated user loaded by `AccessTokenGuard`.
 */
export interface AuthenticatedRequest extends Request {
  user: User;
}

/**
 * Guard that validates the `Authorization: Bearer <jwt>` header, resolves the
 * signed user, and attaches the entity to `req.user` for `@CurrentUser()`.
 */
@Injectable()
export class AccessTokenGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly userDatabaseService: UserDatabaseService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = this.extractBearerToken(request);

    if (!token) {
      throw new UnauthorizedException('Missing bearer token');
    }

    let payload: AccessTokenPayload;

    try {
      payload = await this.jwtService.verifyAsync<AccessTokenPayload>(token);
    } catch {
      throw new UnauthorizedException('Invalid or expired access token');
    }

    const user = await this.userDatabaseService.findOneBy({ id: payload.sub });

    if (!user) {
      throw new UnauthorizedException('User no longer exists');
    }

    request.user = user;

    return true;
  }

  /**
   * Extracts the raw JWT from an `Authorization: Bearer <token>` header.
   */
  private extractBearerToken = (request: Request): string | null => {
    const header = request.headers.authorization;

    if (!header || !header.startsWith('Bearer ')) {
      return null;
    }

    const token = header.slice('Bearer '.length).trim();

    return token.length > 0 ? token : null;
  };
}
