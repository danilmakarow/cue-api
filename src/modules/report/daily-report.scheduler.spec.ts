import { DailyReportScheduler } from './daily-report.scheduler';
import { User, UserReportSettings } from '@/modules/database/entities';

/**
 * Builds a {@link DailyReportScheduler} with mocked collaborators. Each test
 * programs the enabled set, the resolved user, and the generator/sender, then
 * invokes `sweep(now)` directly (the `@Cron` decorator only registers the
 * schedule; the method body is the unit under test). `now` is injected so a test
 * can pin the wall clock deterministically.
 */
const buildHarness = () => {
  const settingsRows = new Map<string, UserReportSettings>();
  const users = new Map<string, User>();

  const userReportSettingsDatabaseService = {
    findAllEnabled: jest.fn(async () =>
      [...settingsRows.values()].filter((row) => row.enabled),
    ),
    findByUserId: jest.fn(
      async (userId: string) => settingsRows.get(userId) ?? null,
    ),
    save: jest.fn(async (row: UserReportSettings) => {
      settingsRows.set(row.userId, row);

      return row;
    }),
  };

  const userDatabaseService = {
    findOneBy: jest.fn(async ({ id }: { id: string }) => users.get(id) ?? null),
  };

  const reportGeneratorService = {
    generateForUser: jest.fn(
      async (
        _user: User,
        _reportDate: string,
        _correlationId: string,
      ): Promise<string | null> => 'Good morning, Tony. A quiet day ahead.',
    ),
  };

  const reportSenderService = {
    send: jest.fn(async () => true),
  };

  const service = new DailyReportScheduler(
    userReportSettingsDatabaseService as never,
    userDatabaseService as never,
    reportGeneratorService as never,
    reportSenderService as never,
  );

  /** Seeds a user + their report-settings row into the in-memory stores. */
  const seed = (
    userId: string,
    timezone: string,
    reportTimeLocal: string,
    overrides: Partial<UserReportSettings> = {},
  ) => {
    users.set(userId, {
      id: userId,
      timezone,
      displayName: 'Tony',
    } as User);

    settingsRows.set(userId, {
      userId,
      enabled: true,
      reportTimeLocal,
      lastSentLocalDate: null,
      ...overrides,
    } as UserReportSettings);
  };

  return {
    service,
    userReportSettingsDatabaseService,
    userDatabaseService,
    reportGeneratorService,
    reportSenderService,
    seed,
    settingsRows,
  };
};

describe('DailyReportScheduler (Story 17 / ADR 0046)', () => {
  it('sends exactly once when local time crosses reportTimeLocal, and is idempotent for the rest of the local day', async () => {
    const harness = buildHarness();

    // 08:00 in Europe/Berlin (UTC+2 in June) is 06:00Z.
    harness.seed('user-1', 'Europe/Berlin', '08:00');

    const atEight = new Date('2026-06-21T06:00:00.000Z');

    await harness.service.sweep(atEight);

    expect(
      harness.reportGeneratorService.generateForUser,
    ).toHaveBeenCalledTimes(1);
    expect(harness.reportSenderService.send).toHaveBeenCalledTimes(1);
    expect(harness.settingsRows.get('user-1')?.lastSentLocalDate).toBe(
      '2026-06-21',
    );

    // A SECOND scan in the very same local minute must NOT re-send (idempotent).
    await harness.service.sweep(atEight);

    expect(harness.reportSenderService.send).toHaveBeenCalledTimes(1);

    // And a later minute of the same local day is still skipped.
    await harness.service.sweep(new Date('2026-06-21T06:01:00.000Z'));

    expect(harness.reportSenderService.send).toHaveBeenCalledTimes(1);
  });

  it('skips a user whose local time does not match reportTimeLocal', async () => {
    const harness = buildHarness();

    harness.seed('user-1', 'Europe/Berlin', '08:00');

    // 07:00Z = 09:00 Berlin — not a match.
    await harness.service.sweep(new Date('2026-06-21T07:00:00.000Z'));

    expect(
      harness.reportGeneratorService.generateForUser,
    ).not.toHaveBeenCalled();
    expect(harness.reportSenderService.send).not.toHaveBeenCalled();
    expect(harness.settingsRows.get('user-1')?.lastSentLocalDate).toBeNull();
  });

  it('honours each user own timezone — two users get reports at their own local 08:00', async () => {
    const harness = buildHarness();

    harness.seed('berlin', 'Europe/Berlin', '08:00'); // 08:00 local = 06:00Z
    harness.seed('kyiv', 'Europe/Kyiv', '08:00'); // 08:00 local = 05:00Z (UTC+3)

    // At 06:00Z only Berlin is due.
    await harness.service.sweep(new Date('2026-06-21T06:00:00.000Z'));

    expect(harness.reportSenderService.send).toHaveBeenCalledTimes(1);
    expect(harness.reportSenderService.send).toHaveBeenCalledWith(
      'berlin',
      expect.any(String),
    );
    expect(harness.settingsRows.get('berlin')?.lastSentLocalDate).toBe(
      '2026-06-21',
    );
    expect(harness.settingsRows.get('kyiv')?.lastSentLocalDate).toBeNull();

    // At 05:00Z Kyiv is due (and was not on the earlier minute).
    await harness.service.sweep(new Date('2026-06-21T05:00:00.000Z'));

    expect(harness.reportSenderService.send).toHaveBeenCalledTimes(2);
    expect(harness.reportSenderService.send).toHaveBeenLastCalledWith(
      'kyiv',
      expect.any(String),
    );
  });

  it("does not abort the scan when one user's generation throws — the other still sends", async () => {
    const harness = buildHarness();

    harness.seed('bad', 'Europe/Berlin', '08:00');
    harness.seed('good', 'Europe/Berlin', '08:00');

    harness.reportGeneratorService.generateForUser.mockImplementation(
      async (user: User) => {
        if (user.id === 'bad') {
          throw new Error('agenda fetch blew up');
        }

        return 'Good morning.';
      },
    );

    const atEight = new Date('2026-06-21T06:00:00.000Z');

    await expect(harness.service.sweep(atEight)).resolves.toBeUndefined();

    // The good user still got their report despite the bad user throwing.
    expect(harness.reportSenderService.send).toHaveBeenCalledTimes(1);
    expect(harness.reportSenderService.send).toHaveBeenCalledWith(
      'good',
      expect.any(String),
    );
    // The failed user's day is NOT marked (no save committed for it).
    expect(harness.settingsRows.get('bad')?.lastSentLocalDate).toBeNull();
    expect(harness.settingsRows.get('good')?.lastSentLocalDate).toBe(
      '2026-06-21',
    );
  });

  it('rolls back the sent-mark when the user has no link to deliver to (send returns false)', async () => {
    const harness = buildHarness();

    harness.seed('user-1', 'Europe/Berlin', '08:00');
    harness.reportSenderService.send.mockResolvedValueOnce(false);

    await harness.service.sweep(new Date('2026-06-21T06:00:00.000Z'));

    expect(
      harness.reportGeneratorService.generateForUser,
    ).toHaveBeenCalledTimes(1);
    // Mark rolled back so a later link + minute can retry.
    expect(harness.settingsRows.get('user-1')?.lastSentLocalDate).toBeNull();
  });

  it('leaves the day un-marked when generation returns null (empty report)', async () => {
    const harness = buildHarness();

    harness.seed('user-1', 'Europe/Berlin', '08:00');
    harness.reportGeneratorService.generateForUser.mockResolvedValueOnce(null);

    await harness.service.sweep(new Date('2026-06-21T06:00:00.000Z'));

    expect(harness.reportSenderService.send).not.toHaveBeenCalled();
    expect(harness.settingsRows.get('user-1')?.lastSentLocalDate).toBeNull();
  });

  it('does nothing and never throws when there are no opted-in users', async () => {
    const harness = buildHarness();

    await expect(harness.service.sweep(new Date())).resolves.toBeUndefined();

    expect(harness.userDatabaseService.findOneBy).not.toHaveBeenCalled();
    expect(
      harness.reportGeneratorService.generateForUser,
    ).not.toHaveBeenCalled();
  });

  it('never throws when loading the candidate set fails (scheduler resilience)', async () => {
    const harness = buildHarness();

    harness.userReportSettingsDatabaseService.findAllEnabled.mockRejectedValueOnce(
      new Error('db unreachable'),
    );

    await expect(harness.service.sweep(new Date())).resolves.toBeUndefined();
  });
});
