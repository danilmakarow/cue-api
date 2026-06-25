import { UserService } from './user.service';
import { User } from '@/modules/database/entities';

/**
 * Builds a {@link UserService} over an in-memory user store so each test can
 * assert the PATCH-validates/short-circuits behaviour of `updateSettings`.
 * `findOneByOrThrow` mirrors the real DB service: returns the row by id or throws
 * when absent; `save` writes the mutated row back.
 */
const buildHarness = () => {
  const rows = new Map<string, User>();

  rows.set('user-1', { id: 'user-1', timezone: 'UTC' } as User);

  const userDatabaseService = {
    findOneByOrThrow: jest.fn(async ({ id }: { id: string }) => {
      const existing = rows.get(id);

      if (!existing) {
        throw new Error(`No user ${id}`);
      }

      return existing;
    }),
    save: jest.fn(async (row: User) => {
      rows.set(row.id, row);

      return row;
    }),
  };

  const service = new UserService(userDatabaseService as never);

  return { service, userDatabaseService, rows };
};

describe('UserService.updateSettings', () => {
  it('persists a valid IANA timezone via save', async () => {
    const { service, userDatabaseService } = buildHarness();

    const updated = await service.updateSettings('user-1', {
      timezone: 'Europe/Berlin',
    });

    expect(updated.timezone).toBe('Europe/Berlin');
    expect(userDatabaseService.save).toHaveBeenCalledTimes(1);
  });

  it('is a no-op (no save) when the timezone is unchanged', async () => {
    const { service, userDatabaseService } = buildHarness();

    const result = await service.updateSettings('user-1', { timezone: 'UTC' });

    expect(result.timezone).toBe('UTC');
    expect(userDatabaseService.save).not.toHaveBeenCalled();
  });

  it('is a no-op (no save) when the payload is empty', async () => {
    const { service, userDatabaseService } = buildHarness();

    await service.updateSettings('user-1', {});

    expect(userDatabaseService.save).not.toHaveBeenCalled();
  });
});
