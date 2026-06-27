import { UserService } from './user.service';
import { AppleTokenRevoker } from '@/modules/auth/apple-token.revoker';
import { User } from '@/modules/database/entities';

/**
 * Builds a {@link UserService} over an in-memory user store so each test can
 * assert the PATCH-validates/short-circuits behaviour of `updateSettings` and
 * the cascade-purge + Apple-revocation behaviour of `deleteAccount`.
 * `findOneByOrThrow` mirrors the real DB service: returns the row by id or throws
 * when absent; `save` writes the mutated row back; `deleteOrThrow` removes it;
 * `revokeAppleToken` stands in for the auth service's Apple-revocation slice.
 */
const buildHarness = () => {
  const rows = new Map<string, User>();

  rows.set('user-1', {
    id: 'user-1',
    timezone: 'UTC',
    displayName: 'Jane',
    avatarBase64: null,
    morningBriefEnabled: true,
    eveningRecapEnabled: true,
  } as User);

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
    deleteOrThrow: jest.fn(async (id: string) => {
      rows.delete(id);

      return { affected: 1 };
    }),
  };

  const appleTokenRevoker = {
    revokeRefreshToken: jest.fn().mockResolvedValue(undefined),
  };

  const service = new UserService(
    userDatabaseService as never,
    appleTokenRevoker as unknown as AppleTokenRevoker,
  );

  return { service, userDatabaseService, appleTokenRevoker, rows };
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

  it('persists a changed displayName via save', async () => {
    const { service, userDatabaseService } = buildHarness();

    const updated = await service.updateSettings('user-1', {
      displayName: 'Jane Appleseed',
    });

    expect(updated.displayName).toBe('Jane Appleseed');
    expect(userDatabaseService.save).toHaveBeenCalledTimes(1);
  });

  it('persists changed avatar and notification prefs via save', async () => {
    const { service } = buildHarness();

    const updated = await service.updateSettings('user-1', {
      avatarBase64: 'aGVsbG8=',
      morningBriefEnabled: false,
      eveningRecapEnabled: false,
    });

    expect(updated.avatarBase64).toBe('aGVsbG8=');
    expect(updated.morningBriefEnabled).toBe(false);
    expect(updated.eveningRecapEnabled).toBe(false);
  });

  it('is a no-op (no save) when the timezone is unchanged', async () => {
    const { service, userDatabaseService } = buildHarness();

    const result = await service.updateSettings('user-1', { timezone: 'UTC' });

    expect(result.timezone).toBe('UTC');
    expect(userDatabaseService.save).not.toHaveBeenCalled();
  });

  it('is a no-op (no save) when every provided field matches', async () => {
    const { service, userDatabaseService } = buildHarness();

    await service.updateSettings('user-1', {
      timezone: 'UTC',
      displayName: 'Jane',
      morningBriefEnabled: true,
    });

    expect(userDatabaseService.save).not.toHaveBeenCalled();
  });

  it('is a no-op (no save) when the payload is empty', async () => {
    const { service, userDatabaseService } = buildHarness();

    await service.updateSettings('user-1', {});

    expect(userDatabaseService.save).not.toHaveBeenCalled();
  });
});

describe('UserService.deleteAccount', () => {
  it('revokes the Apple token then cascade-deletes the user row', async () => {
    const { service, userDatabaseService, appleTokenRevoker, rows } =
      buildHarness();

    await service.deleteAccount('user-1');

    expect(appleTokenRevoker.revokeRefreshToken).toHaveBeenCalledTimes(1);
    expect(userDatabaseService.deleteOrThrow).toHaveBeenCalledWith('user-1');
    expect(rows.has('user-1')).toBe(false);

    // Revocation must precede the purge so the call is made while the account
    // still exists.
    const revokeOrder =
      appleTokenRevoker.revokeRefreshToken.mock.invocationCallOrder[0];
    const deleteOrder =
      userDatabaseService.deleteOrThrow.mock.invocationCallOrder[0];

    expect(revokeOrder).toBeLessThan(deleteOrder);
  });

  it('throws when the user does not exist (and does not delete)', async () => {
    const { service, userDatabaseService } = buildHarness();

    await expect(service.deleteAccount('ghost')).rejects.toThrow();
    expect(userDatabaseService.deleteOrThrow).not.toHaveBeenCalled();
  });
});
