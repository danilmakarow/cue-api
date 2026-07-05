import { Inject, Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';

import { REDIS_CLIENT } from '@/modules/redis/redis.module';

/** Redis key prefix for the per-user-per-local-day cached daily-brief text. */
export const DAILY_BRIEF_KEY_PREFIX = 'report:daily-brief';

/**
 * TTL for a cached daily brief, in seconds. 24h bounds the cost of the MAIN-model
 * call to at most one generation per user per local day while letting a stale
 * entry self-expire (the local date is part of the key, so a new day misses
 * regardless). Kept module-local to avoid widening the env schema for a single
 * constant.
 */
export const DAILY_BRIEF_TTL_SECONDS = 24 * 60 * 60;

/**
 * Builds the cache key for a user's brief on a given local date. The local
 * `YYYY-MM-DD` (not a UTC instant) keys the entry so each local day is a distinct
 * slot and a regenerated brief for the same day reuses the same key.
 */
export const dailyBriefKey = (userId: string, localDate: string): string =>
  `${DAILY_BRIEF_KEY_PREFIX}:${userId}:${localDate}`;

/**
 * Redis-backed cache for the generated daily-brief text, keyed per user + local
 * date (D2). The brief is a MAIN-model completion, so an uncached per-open call
 * is a real cost; this store bounds it to one generation per user per local day.
 * Only non-empty briefs are cached — an empty generation is never stored so a
 * later request can retry. The store owns persistence only; the generation and
 * the cache-aside orchestration live in {@link DailyBriefService}.
 */
@Injectable()
export class DailyBriefCacheStore {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /**
   * Reads the cached brief for a user + local date, or null on a miss (never
   * generated for that day, or the entry has TTL'd out).
   */
  async get(userId: string, localDate: string): Promise<string | null> {
    return this.redis.get(dailyBriefKey(userId, localDate));
  }

  /**
   * Caches the brief text for a user + local date under the 24h TTL. The caller
   * only ever passes a non-empty brief — an empty generation is skipped upstream
   * so a later request can regenerate.
   */
  async set(userId: string, localDate: string, brief: string): Promise<void> {
    await this.redis.set(
      dailyBriefKey(userId, localDate),
      brief,
      'EX',
      DAILY_BRIEF_TTL_SECONDS,
    );
  }

  /**
   * Drops the cached brief for a user + local date so the next read misses and
   * regenerates. Used when the user changes their brief settings, so the new
   * custom prompt takes effect immediately. Idempotent — a no-op when the key
   * is already absent.
   */
  async invalidate(userId: string, localDate: string): Promise<void> {
    await this.redis.del(dailyBriefKey(userId, localDate));
  }
}
