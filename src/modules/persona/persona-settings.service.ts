import { Injectable } from '@nestjs/common';
import { IsNull } from 'typeorm';

import { UpdatePersonaSettingsDto } from './dtos';
import {
  DEFAULT_PERSONA_NAME,
  DEFAULT_PERSONA_TEXT,
} from './persona.constants';
import {
  PersonaPrompt,
  PersonaPromptSource,
} from '@/modules/database/entities';
import { PersonaPromptDatabaseService } from '@/modules/database/services';

/**
 * Service owning the per-user AI persona settings (Story 18 / ADR 0014): the
 * GET-resolves-active read and the validated PATCH upsert. The REST controller is
 * the sole caller; the context builder reads the active text directly from the
 * database service. Writes go through the 3-layer `.save()` path (the database
 * service short-circuits when nothing changed).
 */
@Injectable()
export class PersonaSettingsService {
  constructor(
    private readonly personaPromptDatabaseService: PersonaPromptDatabaseService,
  ) {}

  /**
   * Builds an in-memory `PersonaPrompt` carrying the code-constant Jarvis default,
   * used when a user has no custom persona AND the seeded preset row is absent so
   * the GET endpoint always returns a usable persona (never 404 / empty).
   */
  private static buildDefaultPersona(): PersonaPrompt {
    const fallback = new PersonaPrompt();

    fallback.userId = null;
    fallback.presetName = DEFAULT_PERSONA_NAME;
    fallback.promptText = DEFAULT_PERSONA_TEXT;
    fallback.source = PersonaPromptSource.PRESET;

    return fallback;
  }

  /**
   * Resolves the user's active persona for the GET endpoint: their own `CUSTOM`
   * row, else the seeded "Jarvis" preset, else the code-constant default. Always
   * returns a persona so the iOS Settings screen has something to render.
   */
  async getActive(userId: string): Promise<PersonaPrompt> {
    const active =
      await this.personaPromptDatabaseService.findActivePersona(userId);

    return active ?? PersonaSettingsService.buildDefaultPersona();
  }

  /**
   * Persists the user's custom persona text (validated non-empty + length-bounded
   * by the DTO) and returns the resulting `CUSTOM` row. Upserts via the database
   * service, which no-op short-circuits when the text is unchanged.
   */
  async update(
    userId: string,
    dto: UpdatePersonaSettingsDto,
  ): Promise<PersonaPrompt> {
    return this.personaPromptDatabaseService.upsertCustomForUser(
      userId,
      dto.promptText,
    );
  }

  /**
   * Lists every curated `PRESET` persona (D9) — the user-agnostic rows seeded into
   * the DB (`userId IS NULL`, `source = PRESET`) the iOS persona screen offers as
   * pickable starting points. Returns an empty array when the seed migration has
   * not run; never includes any user's `CUSTOM` row.
   */
  async listPresets(): Promise<PersonaPrompt[]> {
    return this.personaPromptDatabaseService.findAllBy({
      userId: IsNull(),
      source: PersonaPromptSource.PRESET,
    });
  }

  /**
   * Clears the user's `CUSTOM` persona (D9 reset-to-preset) and returns the now
   * active persona — the seeded "Jarvis" preset, or the code-constant default when
   * the seed is absent. Idempotent: a user with no custom persona still gets the
   * fallback back, so the iOS screen can re-render the preset either way.
   */
  async clearCustom(userId: string): Promise<PersonaPrompt> {
    await this.personaPromptDatabaseService.delete({
      userId,
      source: PersonaPromptSource.CUSTOM,
    });

    return this.getActive(userId);
  }
}
