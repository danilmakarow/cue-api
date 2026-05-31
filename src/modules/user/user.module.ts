import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';

import { UserService } from './user.service';

/**
 * User module handling Cue user profile data and Apple Sign-in identities.
 */
@Module({
  imports: [DatabaseModule],
  providers: [UserService],
  exports: [UserService],
})
export class UserModule {}
