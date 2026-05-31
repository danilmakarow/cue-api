import { CanActivate, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { EnvironmentVariables } from '@/config/env.config';

/**
 * Guard that hides an endpoint outside of the `development` environment.
 * Throws `NotFoundException` so the surface looks identical to a missing
 * route in production — no signal that a debug-only handler exists.
 */
@Injectable()
export class DevOnlyGuard implements CanActivate {
  constructor(
    private readonly configService: ConfigService<EnvironmentVariables, true>,
  ) {}

  canActivate(): boolean {
    const env = this.configService.get('NODE_ENV', { infer: true });

    if (env !== 'development') {
      throw new NotFoundException();
    }

    return true;
  }
}
