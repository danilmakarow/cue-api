import { DeviceService } from './device.service';
import { EntityNotFoundException } from '@/exceptions/entity-not-found.exception';
import { Device, DevicePlatform } from '@/modules/database/entities';

/**
 * Builds a {@link DeviceService} over an in-memory device store so each test can
 * assert the register-upserts and unregister-scoped behaviour. `findByApnsToken`,
 * `findOneBy`, `createInstance`, `save`, and `delete` mirror the real
 * DeviceDatabaseService contract the service consumes.
 */
const buildHarness = () => {
  const rows = new Map<string, Device>();
  let idCounter = 0;

  const deviceDatabaseService = {
    findByApnsToken: jest.fn(async (apnsToken: string) => {
      return (
        [...rows.values()].find((row) => row.apnsToken === apnsToken) ?? null
      );
    }),
    findOneBy: jest.fn(async (where: { userId: string; apnsToken: string }) => {
      return (
        [...rows.values()].find(
          (row) =>
            row.userId === where.userId && row.apnsToken === where.apnsToken,
        ) ?? null
      );
    }),
    createInstance: jest.fn(
      (partial: Partial<Device>) => ({ ...partial }) as Device,
    ),
    save: jest.fn(async (entity: Device) => {
      if (!entity.id) {
        entity.id = `device-${++idCounter}`;
      }

      rows.set(entity.id, entity);

      return entity;
    }),
    delete: jest.fn(async (id: string) => {
      rows.delete(id);

      return { affected: 1, raw: [] };
    }),
  };

  const service = new DeviceService(deviceDatabaseService as never);

  return { service, deviceDatabaseService, rows };
};

describe('DeviceService (S2 push registration)', () => {
  it('register inserts a new device row for an unknown token', async () => {
    const { service, deviceDatabaseService } = buildHarness();

    const device = await service.register('user-1', {
      token: 'token-abc',
      platform: DevicePlatform.IOS,
    });

    expect(device.userId).toBe('user-1');
    expect(device.apnsToken).toBe('token-abc');
    expect(device.platform).toBe(DevicePlatform.IOS);
    expect(device.lastSeenAt).toBeInstanceOf(Date);
    expect(device.id).toBeDefined();
    expect(deviceDatabaseService.createInstance).toHaveBeenCalledTimes(1);
  });

  it('register is idempotent — re-posting a known token upserts the same row, not a duplicate', async () => {
    const { service, deviceDatabaseService, rows } = buildHarness();

    const first = await service.register('user-1', {
      token: 'token-abc',
      platform: DevicePlatform.IOS,
    });
    const second = await service.register('user-1', {
      token: 'token-abc',
      platform: DevicePlatform.IOS,
    });

    expect(second.id).toBe(first.id);
    expect(rows.size).toBe(1);
    // The second call went through the existing-row branch, not a fresh insert.
    expect(deviceDatabaseService.createInstance).toHaveBeenCalledTimes(1);
  });

  it('register re-claims an existing token to the new owner and refreshes platform', async () => {
    const { service } = buildHarness();

    await service.register('user-1', {
      token: 'token-abc',
      platform: DevicePlatform.IOS,
    });

    const reclaimed = await service.register('user-2', {
      token: 'token-abc',
      platform: DevicePlatform.IPADOS,
    });

    expect(reclaimed.userId).toBe('user-2');
    expect(reclaimed.platform).toBe(DevicePlatform.IPADOS);
  });

  it('unregister deletes the caller-owned device row', async () => {
    const { service, deviceDatabaseService, rows } = buildHarness();

    await service.register('user-1', {
      token: 'token-abc',
      platform: DevicePlatform.IOS,
    });

    await service.unregister('user-1', 'token-abc');

    expect(rows.size).toBe(0);
    expect(deviceDatabaseService.delete).toHaveBeenCalledTimes(1);
  });

  it('unregister throws when no row matches the token for this user', async () => {
    const { service } = buildHarness();

    await expect(service.unregister('user-1', 'missing')).rejects.toThrow(
      EntityNotFoundException,
    );
  });

  it('unregister cannot remove another user device token (scoped to caller)', async () => {
    const { service, rows } = buildHarness();

    await service.register('user-1', {
      token: 'token-abc',
      platform: DevicePlatform.IOS,
    });

    // user-2 attempts to unregister user-1's token.
    await expect(service.unregister('user-2', 'token-abc')).rejects.toThrow(
      EntityNotFoundException,
    );
    expect(rows.size).toBe(1);
  });
});
