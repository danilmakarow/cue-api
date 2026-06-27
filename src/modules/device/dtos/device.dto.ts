import { ApiProperty } from '@nestjs/swagger';

import { Device, DevicePlatform } from '@/modules/database/entities';

/**
 * Wire shape for a registered Device. Returned by POST /users/me/devices.
 * Intentionally omits the owning `userId` (implicit from the authed caller).
 */
export class DeviceDTO {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({
    description: 'The opaque APNs device token.',
    example: '740f4707bebcf74f9b7c25d48e3358945f6aa01da5ddb387462c7eaf61bb78ad',
  })
  token: string;

  @ApiProperty({ enum: DevicePlatform, enumName: 'DevicePlatform' })
  platform: DevicePlatform;

  @ApiProperty({ format: 'date-time', nullable: true })
  lastSeenAt: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt: string;
}

/**
 * Maps a Device entity to its `DeviceDTO` wire shape. The entity's `apnsToken`
 * column surfaces to the client as `token`.
 */
export const toDeviceDTO = (device: Device): DeviceDTO => ({
  id: device.id,
  token: device.apnsToken,
  platform: device.platform,
  lastSeenAt: device.lastSeenAt ? device.lastSeenAt.toISOString() : null,
  createdAt: device.createdAt.toISOString(),
  updatedAt: device.updatedAt.toISOString(),
});
