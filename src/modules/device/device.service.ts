import { Injectable } from '@nestjs/common';

import { RegisterDeviceDto } from './dtos';
import { EntityNotFoundException } from '@/exceptions/entity-not-found.exception';
import { Device } from '@/modules/database/entities';
import { DeviceDatabaseService } from '@/modules/database/services';

/**
 * Service handling device registration and APNs token lifecycle. Owns the
 * upsert-on-register and unregister flows for the S2 push-registration endpoints;
 * the actual APNs send pipeline is deferred (backlog D1).
 */
@Injectable()
export class DeviceService {
  constructor(private readonly deviceDatabaseService: DeviceDatabaseService) {}

  /**
   * Registers an APNs token for `userId`, idempotently. A token is globally
   * unique (one physical device → one row), so an existing row is re-claimed to
   * the current user and its platform / `lastSeenAt` refreshed rather than
   * inserting a duplicate — this lets a device that switched accounts re-bind.
   * Returns the persisted Device; skips the write when nothing actually changed.
   */
  async register(userId: string, dto: RegisterDeviceDto): Promise<Device> {
    const now = new Date();
    const existing = await this.deviceDatabaseService.findByApnsToken(
      dto.token,
    );

    if (existing) {
      // Re-claim the row to the current user (a device that switched accounts)
      // and refresh platform + lastSeenAt. The check-in timestamp always moves,
      // so a re-register always persists.
      existing.userId = userId;
      existing.platform = dto.platform;
      existing.lastSeenAt = now;

      return this.deviceDatabaseService.save(existing);
    }

    const device = this.deviceDatabaseService.createInstance({
      userId,
      apnsToken: dto.token,
      platform: dto.platform,
      lastSeenAt: now,
    });

    return this.deviceDatabaseService.save(device);
  }

  /**
   * Unregisters a device token owned by `userId`. Scoped to the caller so one
   * user cannot unregister another user's token. Throws when no matching row
   * exists for this user.
   */
  async unregister(userId: string, token: string): Promise<void> {
    const device = await this.deviceDatabaseService.findOneBy({
      userId,
      apnsToken: token,
    });

    if (!device) {
      throw new EntityNotFoundException(Device);
    }

    await this.deviceDatabaseService.delete(device.id);
  }
}
