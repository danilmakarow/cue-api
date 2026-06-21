import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import {
  PersonaSettingsDTO,
  UpdatePersonaSettingsDto,
  toPersonaSettingsDTO,
} from './dtos';
import { PersonaSettingsService } from './persona-settings.service';
import { CurrentUser } from '@/decorators/current-user.decorator';
import { AccessTokenGuard } from '@/guards/access-token.guard';
import { User } from '@/modules/database/entities';
import { Swagger } from '@/modules/swagger/decorators/swagger.decorator';

/**
 * Controller exposing the per-user AI persona settings (Story 18 / ADR 0014) the
 * iOS Settings screen reads and writes. Telegram exposes NO config — these
 * settings are REST/iOS only. All routes require a valid JWT via
 * `AccessTokenGuard` and operate on the current user (`/users/me/...`).
 */
@ApiTags('Users')
@UseGuards(AccessTokenGuard)
@Controller('users/me/persona-settings')
export class PersonaSettingsController {
  constructor(
    private readonly personaSettingsService: PersonaSettingsService,
  ) {}

  /**
   * Returns the current user's active persona — their own custom text when set,
   * otherwise the seeded "Jarvis" default.
   */
  @Get()
  @Swagger({
    summary: 'Get the current user AI persona (the Jarvis default when unset).',
    responseDto: PersonaSettingsDTO,
    responseStatus: 200,
  })
  async get(@CurrentUser() user: User): Promise<PersonaSettingsDTO> {
    const persona = await this.personaSettingsService.getActive(user.id);

    return toPersonaSettingsDTO(persona);
  }

  /**
   * Updates the current user's custom persona text (validated non-empty +
   * length-bounded). Returns the persisted shape.
   */
  @Patch()
  @Swagger({
    summary: 'Update the current user custom AI persona.',
    responseDto: PersonaSettingsDTO,
    responseStatus: 200,
  })
  async update(
    @CurrentUser() user: User,
    @Body() dto: UpdatePersonaSettingsDto,
  ): Promise<PersonaSettingsDTO> {
    const persona = await this.personaSettingsService.update(user.id, dto);

    return toPersonaSettingsDTO(persona);
  }
}
