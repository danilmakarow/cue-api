import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { PersonaPresetDTO, toPersonaPresetDTO } from './dtos';
import { PersonaSettingsService } from './persona-settings.service';
import { CurrentUser } from '@/decorators/current-user.decorator';
import { AccessTokenGuard } from '@/guards/access-token.guard';
import { User } from '@/modules/database/entities';
import { Swagger } from '@/modules/swagger/decorators/swagger.decorator';

/**
 * Controller listing the curated AI persona presets (D9) the iOS persona screen
 * offers as pickable starting points. User-agnostic content, but JWT-guarded like
 * the rest of `/users/me/...` so only signed-in clients read it. Kept separate
 * from the per-user `persona-settings` controller purely because it sits at a
 * different path (`/users/me/persona-presets`).
 */
@ApiTags('Users')
@UseGuards(AccessTokenGuard)
@Controller('users/me/persona-presets')
export class PersonaPresetsController {
  constructor(
    private readonly personaSettingsService: PersonaSettingsService,
  ) {}

  /**
   * Lists every seeded persona preset (D9). The `@CurrentUser()` binding only
   * gates the route behind a valid session — the list itself is the same curated
   * set for every user. Returns an empty array when the seed has not run.
   */
  @Get()
  @Swagger({
    summary: 'List the curated AI persona presets the user can adopt.',
    responseDto: PersonaPresetDTO,
    isResponseArray: true,
    responseStatus: 200,
  })
  async list(@CurrentUser() _user: User): Promise<PersonaPresetDTO[]> {
    const presets = await this.personaSettingsService.listPresets();

    return presets.map(toPersonaPresetDTO);
  }
}
