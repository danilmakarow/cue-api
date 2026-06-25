import { Injectable } from '@nestjs/common';

import { UpdateUserSettingsDto } from './dtos';
import { User } from '@/modules/database/entities';
import { UserDatabaseService } from '@/modules/database/services';

/**
 * Service handling business logic for user management.
 */
@Injectable()
export class UserService {
  constructor(private readonly userDatabaseService: UserDatabaseService) {}

  /**
   * Applies a partial update to the signed-in user's mutable account settings
   * (currently `timezone`, validated as a real IANA zone by the DTO). Loads the
   * user, mutates only the provided fields, and persists via `.save()`; when the
   * payload changes nothing, the row is returned as-is without a write.
   */
  async updateSettings(
    userId: string,
    dto: UpdateUserSettingsDto,
  ): Promise<User> {
    const user = await this.userDatabaseService.findOneByOrThrow({
      id: userId,
    });

    let changed = false;

    if (dto.timezone !== undefined && dto.timezone !== user.timezone) {
      user.timezone = dto.timezone;
      changed = true;
    }

    if (!changed) {
      return user;
    }

    return this.userDatabaseService.save(user);
  }
}
