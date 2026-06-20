import { Inject, Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';

import { heldConflictKey } from '../../redis/redis.constants';
import { REDIS_CLIENT } from '../../redis/redis.module';
import { AssistantConfig } from '../assistant.config';
import { HeldConflictBatch } from '../assistant.types';

/**
 * L8 held-conflict store (ADR 0006). Owns the `heldConflictKey` Redis keyspace —
 * the short-TTL stash of a batch of conflicting writes awaiting the user's tap —
 * so the conflict layer reads/burns it without the orchestrator touching Redis
 * directly. Held conflicts are Redis-only by design: a stale overlap must expire
 * rather than resurrect, because the calendar may have moved. Injects the shared
 * {@link Redis} client + {@link AssistantConfig} (for the TTL).
 */
@Injectable()
export class HeldConflictStore {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly config: AssistantConfig,
  ) {}

  /**
   * Stashes a held-conflict batch under its callback token with the configured
   * TTL, so a later confirm/cancel tap can deterministically replay (or drop) it.
   */
  async stash(token: string, batch: HeldConflictBatch): Promise<void> {
    await this.redis.set(
      heldConflictKey(token),
      JSON.stringify(batch),
      'EX',
      this.config.heldConflictTtlSeconds,
    );
  }

  /**
   * Atomically reads and burns the held batch for a token (Redis `GETDEL`),
   * returning null when it already expired or was already consumed. Burning on
   * read guarantees a held batch is replayed at most once.
   */
  async claim(token: string): Promise<HeldConflictBatch | null> {
    const raw = await this.redis.getdel(heldConflictKey(token));

    if (!raw) {
      return null;
    }

    return JSON.parse(raw) as HeldConflictBatch;
  }
}
