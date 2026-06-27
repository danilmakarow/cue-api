import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsString, MaxLength, MinLength } from 'class-validator';

import { DevicePlatform } from '@/modules/database/entities';

/**
 * DTO for registering (or re-registering) an APNs device token for the current
 * user. Idempotent on the server: an already-known token is upserted rather than
 * duplicated. `platform` is one of the {@link DevicePlatform} enum values.
 */
export class RegisterDeviceDto {
  @ApiProperty({
    description: 'The opaque APNs device token issued to the client.',
    example: '740f4707bebcf74f9b7c25d48e3358945f6aa01da5ddb387462c7eaf61bb78ad',
    maxLength: 512,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(512)
  token: string;

  @ApiProperty({
    enum: DevicePlatform,
    enumName: 'DevicePlatform',
    description: 'The platform the token was issued on.',
    example: DevicePlatform.IOS,
  })
  @IsEnum(DevicePlatform)
  platform: DevicePlatform;
}
