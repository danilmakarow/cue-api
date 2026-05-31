import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { User } from '../entities';

import { BaseRepository } from './base.repository';

/**
 * Repository for the User entity. Extends BaseRepository with user-specific query helpers.
 */
@Injectable()
export class UserRepository extends BaseRepository<User> {
  constructor(dataSource: DataSource) {
    super(User, dataSource.createEntityManager());
  }

  /**
   * Retrieves a user by the Apple Sign-in `sub` claim.
   * Returns null if no user is found.
   */
  getByAppleUserId(appleUserId: string) {
    return this.findOne({ where: { appleUserId } });
  }
}
