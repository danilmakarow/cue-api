import { Injectable } from '@nestjs/common';

import {
  ConflictPolicy,
  UserMemoryFact,
  UserMemoryFactSource,
  UserMemoryFactType,
} from '@/modules/database/entities';
import { UserMemoryFactRepository } from '@/modules/database/repositories';
import { BaseDatabaseService } from '@/modules/database/services/base-database.service';

/** The natural key the single standing conflict-policy fact is stored under. */
export const CONFLICT_POLICY_FACT_KEY = 'default';

/**
 * Database service for the UserMemoryFact entity.
 */
@Injectable()
export class UserMemoryFactDatabaseService extends BaseDatabaseService<UserMemoryFact> {
  constructor(userMemoryFactRepository: UserMemoryFactRepository) {
    super(userMemoryFactRepository);
  }

  /**
   * Returns every durable fact for a user, newest-first — the candidate set the
   * context builder filters down to the relevant subset for prompt block 3.
   */
  findAllByUserId(userId: string): Promise<UserMemoryFact[]> {
    return this.findAll({
      where: { userId },
      order: { updatedAt: 'DESC' },
    });
  }

  /**
   * Finds an existing fact by its natural key (userId + type + key), so the
   * background extractor can update it in place instead of duplicating. Returns
   * null when no matching fact exists.
   */
  findByNaturalKey(
    userId: string,
    type: UserMemoryFact['type'],
    key: string,
  ): Promise<UserMemoryFact | null> {
    return this.findOneBy({ userId, type, key });
  }

  /**
   * Resolves the user's STANDING double-booking policy (Story 15 / ADR 0011 +
   * 0044): the disposition on their EXPLICIT `conflict_policy` fact, or null when
   * none is set (the caller then falls back to default-deny / ask). Only an
   * explicit, user-set fact counts as standing authorization — an inferred fact
   * of this type is ignored on purpose, since a policy must never be guessed from
   * a single message. An unrecognized stored value also resolves to null (treated
   * as "no standing policy") so a malformed row can never silently widen access.
   */
  async findConflictPolicy(userId: string): Promise<ConflictPolicy | null> {
    const fact = await this.findByNaturalKey(
      userId,
      UserMemoryFactType.CONFLICT_POLICY,
      CONFLICT_POLICY_FACT_KEY,
    );

    if (!fact || fact.source !== UserMemoryFactSource.EXPLICIT) {
      return null;
    }

    const policy = fact.value?.policy;

    if (
      policy === ConflictPolicy.ALLOW ||
      policy === ConflictPolicy.ASK ||
      policy === ConflictPolicy.DENY
    ) {
      return policy;
    }

    return null;
  }

  /**
   * Records (or updates) the user's STANDING conflict policy as an EXPLICIT
   * `conflict_policy` fact (Story 15 / ADR 0011 + 0044) under the single natural
   * key. EXPLICIT + confidence 1 so it is trusted as standing authorization and
   * never overwritten by the background extractor. This is the recorded path by
   * which a power user opts in ("always let me double-book") or hardens
   * ("never") once and for all — invoked by an explicit settings action, not by
   * the inferring extractor.
   */
  async setConflictPolicy(
    userId: string,
    policy: ConflictPolicy,
  ): Promise<UserMemoryFact> {
    const existing = await this.findByNaturalKey(
      userId,
      UserMemoryFactType.CONFLICT_POLICY,
      CONFLICT_POLICY_FACT_KEY,
    );

    if (existing) {
      if (existing.value?.policy === policy) {
        return existing;
      }

      existing.value = { policy };
      existing.source = UserMemoryFactSource.EXPLICIT;
      existing.confidence = 1;

      return this.save(existing);
    }

    const created = this.createInstance({
      userId,
      type: UserMemoryFactType.CONFLICT_POLICY,
      key: CONFLICT_POLICY_FACT_KEY,
      value: { policy },
      confidence: 1,
      source: UserMemoryFactSource.EXPLICIT,
    });

    return this.save(created);
  }
}
