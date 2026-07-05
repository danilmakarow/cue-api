import { BadRequestException } from '@nestjs/common';
import { DateTime } from 'luxon';

import { BriefSettingsService } from './brief-settings.service';
import { User, UserBriefSettings } from '@/modules/database/entities';

/** The user's CURRENT local day in the test zone — the cache-invalidation key. */
const TODAY_LOCAL = DateTime.now()
  .setZone('Europe/Berlin')
  .toISODate() as string;

/**
 * Builds a {@link BriefSettingsService} over an in-memory brief-settings store +
 * a mocked cache store, so each test can assert the GET-creates-a-default read,
 * the PATCH upsert (set / clear) of `customPrompt`, and that any write invalidates
 * today's cached brief. `findOrCreateForUser` / `upsertCustomPromptForUser` mirror
 * the real DB service contract.
 */
const buildHarness = () => {
  const rows = new Map<string, UserBriefSettings>();

  const userBriefSettingsDatabaseService = {
    findOrCreateForUser: jest.fn(async (userId: string) => {
      const existing = rows.get(userId);

      if (existing) {
        return existing;
      }

      const created = { userId, customPrompt: null } as UserBriefSettings;

      rows.set(userId, created);

      return created;
    }),
    upsertCustomPromptForUser: jest.fn(
      async (userId: string, customPrompt: string | null) => {
        const existing = rows.get(userId);

        if (existing) {
          existing.customPrompt = customPrompt;

          return existing;
        }

        const created = { userId, customPrompt } as UserBriefSettings;

        rows.set(userId, created);

        return created;
      },
    ),
  };

  const dailyBriefCacheStore = {
    invalidate: jest.fn(
      async (_userId: string, _localDate: string): Promise<void> => undefined,
    ),
  };

  const service = new BriefSettingsService(
    userBriefSettingsDatabaseService as never,
    dailyBriefCacheStore as never,
  );

  return {
    service,
    userBriefSettingsDatabaseService,
    dailyBriefCacheStore,
    rows,
  };
};

const user = (overrides: Partial<User> = {}): User =>
  ({
    id: 'user-1',
    timezone: 'Europe/Berlin',
    displayName: 'Tony',
    ...overrides,
  }) as User;

describe('BriefSettingsService', () => {
  it('getOrCreate returns a default (null customPrompt) on the first read', async () => {
    const { service } = buildHarness();

    const settings = await service.getOrCreate('user-1');

    expect(settings.customPrompt).toBeNull();
  });

  it('update sets the custom prompt and invalidates today cached brief', async () => {
    const { service, userBriefSettingsDatabaseService, dailyBriefCacheStore } =
      buildHarness();

    const settings = await service.update(user(), {
      customPrompt: 'Keep it very brief.',
    });

    expect(settings.customPrompt).toBe('Keep it very brief.');
    expect(
      userBriefSettingsDatabaseService.upsertCustomPromptForUser,
    ).toHaveBeenCalledWith('user-1', 'Keep it very brief.');
    // The cache-bust targets today's brief for the user (their local date).
    expect(dailyBriefCacheStore.invalidate).toHaveBeenCalledWith(
      'user-1',
      TODAY_LOCAL,
    );
  });

  it('update with null clears the custom prompt (and still invalidates)', async () => {
    const { service, dailyBriefCacheStore } = buildHarness();

    // First set it, then clear it.
    await service.update(user(), { customPrompt: 'something' });

    const cleared = await service.update(user(), { customPrompt: null });

    expect(cleared.customPrompt).toBeNull();
    expect(dailyBriefCacheStore.invalidate).toHaveBeenCalledTimes(2);
  });

  it('reset clears the custom prompt, invalidates the cache, and is idempotent', async () => {
    const { service, userBriefSettingsDatabaseService, dailyBriefCacheStore } =
      buildHarness();

    // reset with no prior row still succeeds and returns a cleared row.
    const settings = await service.reset(user());

    expect(settings.customPrompt).toBeNull();
    expect(
      userBriefSettingsDatabaseService.upsertCustomPromptForUser,
    ).toHaveBeenCalledWith('user-1', null);
    expect(dailyBriefCacheStore.invalidate).toHaveBeenCalledWith(
      'user-1',
      TODAY_LOCAL,
    );
  });

  it('rejects an invalid user timezone with 400 on a write', async () => {
    const { service, dailyBriefCacheStore } = buildHarness();

    await expect(
      service.update(user({ timezone: 'Not/AZone' }), {
        customPrompt: 'x',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    // A bad zone means we could not compute the key — no invalidation happened.
    expect(dailyBriefCacheStore.invalidate).not.toHaveBeenCalled();
  });
});
