import { ReportSettingsService } from './report-settings.service';
import { UserReportSettings } from '@/modules/database/entities';

/**
 * Builds a {@link ReportSettingsService} over an in-memory settings store so each
 * test can assert the GET-creates-a-default and PATCH-validates/short-circuits
 * behaviour. `findOrCreateForUser` mirrors the real DB service: returns the row or
 * creates a default (off, 08:00) on first read.
 */
const buildHarness = () => {
  const rows = new Map<string, UserReportSettings>();

  const userReportSettingsDatabaseService = {
    findOrCreateForUser: jest.fn(async (userId: string) => {
      const existing = rows.get(userId);

      if (existing) {
        return existing;
      }

      const created = {
        userId,
        enabled: false,
        reportTimeLocal: '08:00',
        lastSentLocalDate: null,
      } as UserReportSettings;

      rows.set(userId, created);

      return created;
    }),
    save: jest.fn(async (row: UserReportSettings) => {
      rows.set(row.userId, row);

      return row;
    }),
  };

  const service = new ReportSettingsService(
    userReportSettingsDatabaseService as never,
  );

  return { service, userReportSettingsDatabaseService, rows };
};

describe('ReportSettingsService (Story 17 / ADR 0046)', () => {
  it('getOrCreate returns a default (off, 08:00) on the first read', async () => {
    const { service } = buildHarness();

    const settings = await service.getOrCreate('user-1');

    expect(settings.enabled).toBe(false);
    expect(settings.reportTimeLocal).toBe('08:00');
  });

  it('update applies enabled + reportTimeLocal and persists via save', async () => {
    const { service, userReportSettingsDatabaseService } = buildHarness();

    const updated = await service.update('user-1', {
      enabled: true,
      reportTimeLocal: '07:30',
    });

    expect(updated.enabled).toBe(true);
    expect(updated.reportTimeLocal).toBe('07:30');
    expect(userReportSettingsDatabaseService.save).toHaveBeenCalledTimes(1);
  });

  it('update is a no-op (no save) when nothing changed', async () => {
    const { service, userReportSettingsDatabaseService } = buildHarness();

    // Default row is { enabled: false, reportTimeLocal: '08:00' }.
    await service.getOrCreate('user-1');

    const result = await service.update('user-1', {
      enabled: false,
      reportTimeLocal: '08:00',
    });

    expect(result.enabled).toBe(false);
    expect(userReportSettingsDatabaseService.save).not.toHaveBeenCalled();
  });

  it('update saves when only one field changes', async () => {
    const { service, userReportSettingsDatabaseService } = buildHarness();

    await service.getOrCreate('user-1');

    await service.update('user-1', { enabled: true });

    expect(userReportSettingsDatabaseService.save).toHaveBeenCalledTimes(1);
  });
});
