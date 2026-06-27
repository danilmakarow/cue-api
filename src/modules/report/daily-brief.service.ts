import { BadRequestException, Injectable } from '@nestjs/common';
import { DateTime } from 'luxon';

import { DailyBriefCacheStore } from './daily-brief-cache.store';
import { ReportGeneratorService } from './report-generator.service';
import { User } from '@/modules/database/entities';

/** Validates a zero-padded ISO local date `YYYY-MM-DD`. */
const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * How many local days on either side of the user's current day an explicit
 * `date` may target. The brief is a "today" card with a tiny look-back/ahead, so
 * one day each way is generous. Bounding the window caps the distinct cache keys
 * (and therefore the distinct MAIN-model generations) a single user can fan out:
 * the per-day content cache de-dupes repeats of the SAME day, this bounds the set
 * of reachable days. A wider request is rejected with 400.
 */
const DATE_WINDOW_DAYS = 1;

/**
 * The resolved daily brief: the generated text (null when the day yielded nothing
 * usable) plus the canonical local date it covers.
 */
export interface DailyBriefResult {
  brief: string | null;
  localDate: string;
}

/**
 * On-demand daily-brief service (backlog D2). Exposes the otherwise
 * scheduler-only {@link ReportGeneratorService.generateForUser} to the iOS
 * morning-brief card via a cache-aside read: it resolves the user's target local
 * day, returns a cached brief when present, and otherwise generates ONE
 * MAIN-model brief and caches it per `userId + localDate`. The 24h, date-keyed
 * cache (see {@link DailyBriefCacheStore}) bounds the per-open model cost to at
 * most one generation per user per local day.
 */
@Injectable()
export class DailyBriefService {
  constructor(
    private readonly reportGeneratorService: ReportGeneratorService,
    private readonly dailyBriefCacheStore: DailyBriefCacheStore,
  ) {}

  /**
   * Resolves the local date the brief is for. An explicit `date` query param must
   * be a real `YYYY-MM-DD` in the user's timezone (rejected with 400 otherwise)
   * AND fall within ±{@link DATE_WINDOW_DAYS} of the user's CURRENT local day —
   * dates outside that window are rejected with 400 so a single user cannot fan a
   * MAIN-model generation across thousands of attacker-chosen distinct days. When
   * omitted, the user's current local date is used. Returns the canonical
   * `YYYY-MM-DD` so the cache key is stable regardless of input padding.
   */
  private resolveLocalDate(user: User, date?: string): string {
    const today = DateTime.now().setZone(user.timezone).startOf('day');

    if (!today.isValid) {
      throw new BadRequestException(
        `User timezone "${user.timezone}" is not a valid IANA zone.`,
      );
    }

    if (date === undefined) {
      return today.toISODate() as string;
    }

    if (!LOCAL_DATE_PATTERN.test(date)) {
      throw new BadRequestException(
        'date must be an ISO local date (YYYY-MM-DD).',
      );
    }

    const parsed = DateTime.fromISO(date, { zone: user.timezone }).startOf(
      'day',
    );
    const isoDate = parsed.toISODate();

    if (!isoDate) {
      throw new BadRequestException('date must be a valid calendar date.');
    }

    const offsetDays = parsed.diff(today, 'days').days;

    if (Math.abs(offsetDays) > DATE_WINDOW_DAYS) {
      throw new BadRequestException(
        `date must be within ${DATE_WINDOW_DAYS} day(s) of today.`,
      );
    }

    return isoDate;
  }

  /**
   * Returns the daily-brief text for the user on the target local day, generating
   * it on a cache miss. Reads the cache first; on a hit returns immediately. On a
   * miss runs ONE MAIN-model generation, caches a non-empty result, and returns
   * it. A null/empty generation is NOT cached so a later request can retry; the
   * caller surfaces the empty case as it sees fit.
   */
  async getBrief(user: User, date?: string): Promise<DailyBriefResult> {
    const localDate = this.resolveLocalDate(user, date);

    const cached = await this.dailyBriefCacheStore.get(user.id, localDate);

    if (cached !== null) {
      return { brief: cached, localDate };
    }

    const correlationId = `daily-brief-${user.id}-${localDate}`;

    const brief = await this.reportGeneratorService.generateForUser(
      user,
      localDate,
      correlationId,
    );

    if (!brief) {
      return { brief: null, localDate };
    }

    await this.dailyBriefCacheStore.set(user.id, localDate, brief);

    return { brief, localDate };
  }
}
