import { Injectable } from '@nestjs/common';

import { UserDatabaseService } from '@/modules/database/services';

/**
 * Service handling business logic for user management.
 * Skeleton — profile, Apple Sign-in, and timezone handling land in later steps.
 */
@Injectable()
export class UserService {
  constructor(private readonly userDatabaseService: UserDatabaseService) {}
}
