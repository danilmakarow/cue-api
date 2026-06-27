import { BadRequestException } from '@nestjs/common';

import { DailyBriefService } from './daily-brief.service';
import { User } from '@/modules/database/entities';

/**
 * Builds a {@link DailyBriefService} over a mocked generator + an in-memory cache
 * store mirroring {@link DailyBriefCacheStore} (per `userId:localDate` slot). Lets
 * each test assert the cache-aside flow: hit returns without generating, miss
 * generates once + caches, and an empty generation is never cached (so a later
 * request retries).
 */
const buildHarness = () => {
  const cache = new Map<string, string>();

  const reportGeneratorService = {
    generateForUser: jest.fn(
      async (
        _user: User,
        _reportDate: string,
        _correlationId: string,
      ): Promise<string | null> => 'Good morning, Tony.',
    ),
  };

  const dailyBriefCacheStore = {
    get: jest.fn(
      async (userId: string, localDate: string): Promise<string | null> =>
        cache.get(`${userId}:${localDate}`) ?? null,
    ),
    set: jest.fn(
      async (
        userId: string,
        localDate: string,
        brief: string,
      ): Promise<void> => {
        cache.set(`${userId}:${localDate}`, brief);
      },
    ),
  };

  const service = new DailyBriefService(
    reportGeneratorService as never,
    dailyBriefCacheStore as never,
  );

  return { service, reportGeneratorService, dailyBriefCacheStore, cache };
};

const user = (overrides: Partial<User> = {}): User =>
  ({
    id: 'user-1',
    timezone: 'Europe/Berlin',
    displayName: 'Tony',
    ...overrides,
  }) as User;

describe('DailyBriefService (D2)', () => {
  it('generates and caches the brief on a cache miss', async () => {
    const { service, reportGeneratorService, dailyBriefCacheStore } =
      buildHarness();

    const result = await service.getBrief(user(), '2026-06-21');

    expect(result.brief).toBe('Good morning, Tony.');
    expect(result.localDate).toBe('2026-06-21');
    expect(reportGeneratorService.generateForUser).toHaveBeenCalledTimes(1);
    expect(dailyBriefCacheStore.set).toHaveBeenCalledTimes(1);
  });

  it('returns the cached brief WITHOUT generating on a hit', async () => {
    const { service, reportGeneratorService } = buildHarness();

    await service.getBrief(user(), '2026-06-21');

    const second = await service.getBrief(user(), '2026-06-21');

    expect(second.brief).toBe('Good morning, Tony.');
    // Only the first call generated; the second was served from cache.
    expect(reportGeneratorService.generateForUser).toHaveBeenCalledTimes(1);
  });

  it('does NOT cache an empty generation so a later request can retry', async () => {
    const { service, reportGeneratorService, dailyBriefCacheStore } =
      buildHarness();

    reportGeneratorService.generateForUser.mockResolvedValueOnce(null);

    const result = await service.getBrief(user(), '2026-06-21');

    expect(result.brief).toBeNull();
    expect(dailyBriefCacheStore.set).not.toHaveBeenCalled();

    // A second request regenerates (the empty result was not cached).
    await service.getBrief(user(), '2026-06-21');

    expect(reportGeneratorService.generateForUser).toHaveBeenCalledTimes(2);
  });

  it('defaults to the user current local date when no date is given', async () => {
    const { service, reportGeneratorService } = buildHarness();

    await service.getBrief(user());

    const [, reportDate] = reportGeneratorService.generateForUser.mock.calls[0];

    // Whatever "today" is in Berlin, it is a valid ISO local date.
    expect(reportDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('rejects a malformed date with 400', async () => {
    const { service } = buildHarness();

    await expect(service.getBrief(user(), 'not-a-date')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects an impossible calendar date with 400', async () => {
    const { service } = buildHarness();

    await expect(service.getBrief(user(), '2026-02-30')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
