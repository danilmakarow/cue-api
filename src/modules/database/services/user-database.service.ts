import { Injectable } from '@nestjs/common';

import { User } from '@/modules/database/entities';
import { UserRepository } from '@/modules/database/repositories';
import { BaseDatabaseService } from '@/modules/database/services/base-database.service';

/**
 * Database service for the User entity.
 * Extends BaseDatabaseService with user-specific lookup helpers (Apple Sign-in, email).
 */
@Injectable()
export class UserDatabaseService extends BaseDatabaseService<User> {
  constructor(userRepository: UserRepository) {
    super(userRepository);
  }

  /**
   * Finds a user by their Apple Sign-in `sub` claim. Returns null when none exists.
   */
  findByAppleUserId(appleUserId: string) {
    return this.findOneBy({ appleUserId });
  }

  /**
   * Finds a user by Apple id or throws EntityNotFoundException if not found.
   */
  findByAppleUserIdOrThrow(appleUserId: string) {
    return this.findOneByOrThrow({ appleUserId });
  }
}
