import { Injectable } from '@nestjs/common';
import { IsNull } from 'typeorm';

import {
  PersonaPrompt,
  PersonaPromptSource,
} from '@/modules/database/entities';
import { PersonaPromptRepository } from '@/modules/database/repositories';
import { BaseDatabaseService } from '@/modules/database/services/base-database.service';

/** The seeded out-of-box preset's name (Story 18 / ADR 0014). */
export const JARVIS_PRESET_NAME = 'Jarvis';

/**
 * Database service for the PersonaPrompt entity (Story 18 / ADR 0014) — the
 * per-user AI personality plus the curated seeded presets. A user's active
 * persona is their own `CUSTOM` row; absent one, the seeded "Jarvis" `PRESET`
 * row is the fallback (and the context builder applies the code-constant Jarvis
 * text if even the seed is missing, keeping the prompt byte-stable).
 */
@Injectable()
export class PersonaPromptDatabaseService extends BaseDatabaseService<PersonaPrompt> {
  constructor(personaPromptRepository: PersonaPromptRepository) {
    super(personaPromptRepository);
  }

  /**
   * Finds a user's own `CUSTOM` persona row, or null when they have not set one.
   * The unique partial index guarantees at most one per user.
   */
  findCustomByUserId(userId: string): Promise<PersonaPrompt | null> {
    return this.findOneBy({ userId, source: PersonaPromptSource.CUSTOM });
  }

  /**
   * Finds the seeded "Jarvis" preset row (a `PRESET` with no `userId`), or null
   * when the seed migration has not run. Used as the fallback persona when a user
   * has set nothing.
   */
  findSeededPreset(): Promise<PersonaPrompt | null> {
    return this.findOneBy({
      userId: IsNull(),
      source: PersonaPromptSource.PRESET,
      presetName: JARVIS_PRESET_NAME,
    });
  }

  /**
   * Resolves the active persona ROW for a user: their `CUSTOM` row when set, else
   * the seeded preset row, else null (no custom, no seed). The REST GET path uses
   * this to surface `source`/`presetName` alongside the text.
   */
  async findActivePersona(userId: string): Promise<PersonaPrompt | null> {
    const custom = await this.findCustomByUserId(userId);

    if (custom) {
      return custom;
    }

    return this.findSeededPreset();
  }

  /**
   * Resolves the active persona TEXT for a user: their `CUSTOM` text when set,
   * else the seeded preset's text, else null (the caller supplies the code
   * constant). One read on the hot path when the user has a custom persona; two
   * only when falling back to the seed.
   */
  async findActivePersonaText(userId: string): Promise<string | null> {
    const active = await this.findActivePersona(userId);

    return active ? active.promptText : null;
  }

  /**
   * Upserts a user's `CUSTOM` persona text, returning the persisted row. Mutates
   * the existing row in place (no-op short-circuit when the text is unchanged) or
   * creates a fresh one, always through `.save()` per the 3-layer write rule.
   */
  async upsertCustomForUser(
    userId: string,
    promptText: string,
  ): Promise<PersonaPrompt> {
    const existing = await this.findCustomByUserId(userId);

    if (existing) {
      if (existing.promptText === promptText) {
        return existing;
      }

      existing.promptText = promptText;

      return this.save(existing);
    }

    const created = this.createInstance({
      userId,
      promptText,
      source: PersonaPromptSource.CUSTOM,
      presetName: null,
    });

    return this.save(created);
  }
}
