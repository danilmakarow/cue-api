import {
  Body,
  Controller,
  Delete,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiParam, ApiTags } from '@nestjs/swagger';

import { DeviceService } from './device.service';
import { DeviceDTO, RegisterDeviceDto, toDeviceDTO } from './dtos';
import { CurrentUser } from '@/decorators/current-user.decorator';
import { AccessTokenGuard } from '@/guards/access-token.guard';
import { User } from '@/modules/database/entities';
import { Swagger } from '@/modules/swagger/decorators/swagger.decorator';
import { OkResponseDto } from '@/modules/swagger/dtos/ok-response.dto';

/**
 * Controller exposing APNs device-token registration for the current user
 * (backlog S2). Registration only — push delivery is deferred (backlog D1).
 * All routes require a valid JWT via `AccessTokenGuard` and operate on the
 * authed caller (`/users/me/devices`).
 */
@ApiTags('Users')
@UseGuards(AccessTokenGuard)
@Controller('users/me/devices')
export class DeviceController {
  constructor(private readonly deviceService: DeviceService) {}

  /**
   * Registers (upserts) an APNs device token for the current user and returns
   * the persisted row. Idempotent: re-posting a known token refreshes it rather
   * than creating a duplicate.
   */
  @Post()
  @Swagger({
    summary: 'Register (upsert) an APNs device token for the current user.',
    responseDto: DeviceDTO,
    responseStatus: 201,
  })
  async register(
    @CurrentUser() user: User,
    @Body() dto: RegisterDeviceDto,
  ): Promise<DeviceDTO> {
    const device = await this.deviceService.register(user.id, dto);

    return toDeviceDTO(device);
  }

  /**
   * Unregisters the given APNs token for the current user. Responds `200
   * { ok: true }` (a JSON body the iOS client can decode, not a bare 204).
   */
  @Delete(':token')
  @HttpCode(200)
  @ApiParam({ name: 'token', description: 'The APNs device token to remove.' })
  @Swagger({
    summary: 'Unregister an APNs device token; responds 200 { ok: true }.',
    responseDto: OkResponseDto,
    responseStatus: 200,
  })
  async unregister(
    @CurrentUser() user: User,
    @Param('token') token: string,
  ): Promise<{ ok: true }> {
    await this.deviceService.unregister(user.id, token);

    return { ok: true };
  }
}
