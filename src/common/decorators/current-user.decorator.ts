import { ExecutionContext, createParamDecorator } from '@nestjs/common';

import { AuthenticatedRequest } from '@/guards/access-token.guard';
import { User } from '@/modules/database/entities';

/**
 * Parameter decorator that returns the authenticated `User` attached to the
 * request by `AccessTokenGuard`. Usable only on routes protected by that guard.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): User => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    return request.user;
  },
);
