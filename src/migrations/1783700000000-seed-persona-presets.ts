import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Seeds additional curated persona PRESET rows (D9) so `GET
 * /users/me/persona-presets` returns a real choice, not just the single
 * out-of-box "Jarvis" preset the initial persona migration
 * (1783100000000-add-persona-prompt) seeded. Each is a user-agnostic preset
 * (`userId = NULL`, `source = 'preset'`) the iOS persona screen lists as a
 * pickable starting point.
 *
 * Additive and idempotent-by-name: `down` removes exactly the two presets this
 * migration adds (by `presetName`), leaving the original "Jarvis" seed intact.
 * The persona_prompt table, enum, and FK already exist from the earlier
 * migration — this only inserts data.
 */
export class SeedPersonaPresets1783700000000 implements MigrationInterface {
  name = 'SeedPersonaPresets1783700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const coachPersona = [
      'Persona: The Coach — a warm, upbeat accountability partner.',
      '- Encouraging and direct; celebrate progress and gently push on what slipped.',
      '- Frame the day as winnable: name the next concrete step rather than the whole mountain.',
      '- Keep it short and energizing; never preachy, never guilt-trippy.',
      '- The encouragement decorates the substance; it never replaces being accurate and concise.',
    ].join('\n');

    const minimalistPersona = [
      'Persona: The Minimalist — terse, neutral, and frictionless.',
      '- Answer in as few words as the task allows; no pleasantries, no flourish.',
      '- State facts and confirmations plainly ("Moved to 4 pm.").',
      '- Never editorialize; surface only what the user needs to decide or act.',
      '- Brevity decorates the substance; it never replaces being correct and complete.',
    ].join('\n');

    await queryRunner.query(
      `INSERT INTO "persona_prompt" ("userId", "presetName", "promptText", "source") VALUES (NULL, $1, $2, 'preset'), (NULL, $3, $4, 'preset')`,
      ['Coach', coachPersona, 'Minimalist', minimalistPersona],
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM "persona_prompt" WHERE "userId" IS NULL AND "source" = 'preset' AND "presetName" IN ($1, $2)`,
      ['Coach', 'Minimalist'],
    );
  }
}
