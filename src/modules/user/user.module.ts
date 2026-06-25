import { Module } from '@nestjs/common';

import { UserSettingsController } from './user-settings.controller';
import { UserService } from './user.service';
import { DatabaseModule } from '../database/database.module';

/**
 * User module handling Cue user profile data and Apple Sign-in identities. Wires
 * the REST account-settings surface (`GET`/`PATCH /users/me/settings`) behind
 * `AccessTokenGuard`, provided by the `@Global()` `AuthModule` (so it is applied
 * without importing that module, mirroring the other feature controllers).
 */
@Module({
  imports: [DatabaseModule],
  controllers: [UserSettingsController],
  providers: [UserService],
  exports: [UserService],
})
export class UserModule {}
