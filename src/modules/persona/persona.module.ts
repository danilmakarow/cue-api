import { Module } from '@nestjs/common';

import { PersonaPresetsController } from './persona-presets.controller';
import { PersonaSettingsController } from './persona-settings.controller';
import { PersonaSettingsService } from './persona-settings.service';
import { DatabaseModule } from '@/modules/database/database.module';

/**
 * Persona module (Story 18 / ADR 0014) — the per-user AI personality. Wires the
 * REST settings surface (`GET`/`PATCH`/`DELETE /users/me/persona-settings` and
 * the curated-preset list `GET /users/me/persona-presets`, D9) behind
 * `AccessTokenGuard`, provided by the `@Global()` `AuthModule` (so it is applied
 * without importing that module, mirroring the other feature controllers). The
 * active persona is injected into the prompt by the assistant's context builder,
 * which reads the persona database service directly — there is no runtime
 * coupling between this module and the assistant module.
 */
@Module({
  imports: [DatabaseModule],
  controllers: [PersonaSettingsController, PersonaPresetsController],
  providers: [PersonaSettingsService],
  exports: [PersonaSettingsService],
})
export class PersonaModule {}
