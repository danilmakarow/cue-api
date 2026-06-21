import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the `persona_prompt` table (Story 18 / ADR 0014) — the per-user AI
 * personality plus curated seeded presets. UUID PK, `timestamptz` audit columns,
 * a nullable `userId` (null = a curated preset, set = a user's own persona) with
 * an FK cascading from `user`, a `presetName` (set only for presets), a `text`
 * `promptText`, and a `source` enum (`preset` | `custom`).
 *
 * A PARTIAL unique index on `userId WHERE userId IS NOT NULL` enforces at most
 * one custom persona per user while leaving preset rows (all-null `userId`)
 * unconstrained. The migration then SEEDS the out-of-box "Jarvis" preset — a
 * dry, formal English-butler persona — as the fallback persona a user adopts
 * until they write their own.
 */
export class AddPersonaPrompt1783100000000 implements MigrationInterface {
  name = 'AddPersonaPrompt1783100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "persona_prompt_source_enum" AS ENUM('preset', 'custom')`,
    );
    await queryRunner.query(
      `CREATE TABLE "persona_prompt" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "userId" uuid,
        "presetName" character varying,
        "promptText" text NOT NULL,
        "source" "persona_prompt_source_enum" NOT NULL DEFAULT 'custom',
        CONSTRAINT "PK_persona_prompt_id" PRIMARY KEY ("id")
      )`,
    );
    await queryRunner.query(
      `ALTER TABLE "persona_prompt" ADD CONSTRAINT "FK_persona_prompt_userId" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    // At most one CUSTOM persona per user; preset rows (null userId) unconstrained.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_persona_prompt_userId" ON "persona_prompt" ("userId") WHERE "userId" IS NOT NULL`,
    );

    // Seed the out-of-box "Jarvis" preset — the fallback persona until a user
    // writes their own. A parameterized insert keeps the multi-line copy safe.
    const jarvisPersona = [
      'Persona: J.A.R.V.I.S. — a dry, impeccably formal English butler.',
      '- Address the user as "sir" by default; unfailingly polite, calm, and unflappable, never breaking character.',
      '- Wit is dry, deadpan, and understated; a light, civilized remark is welcome, never slapstick.',
      '- Flag a bad idea or a risk with gentle, sardonic concern rather than alarm — a faint "I did try to warn you" undertone.',
      '- When delivering important status, switch to clipped, competent reporting ("Done, sir — moved to 4 pm.").',
      '- The persona decorates the substance; it never replaces being genuinely useful, correct, and concise.',
    ].join('\n');

    await queryRunner.query(
      `INSERT INTO "persona_prompt" ("userId", "presetName", "promptText", "source") VALUES (NULL, $1, $2, 'preset')`,
      ['Jarvis', jarvisPersona],
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."UQ_persona_prompt_userId"`);
    await queryRunner.query(
      `ALTER TABLE "persona_prompt" DROP CONSTRAINT "FK_persona_prompt_userId"`,
    );
    await queryRunner.query(`DROP TABLE "persona_prompt"`);
    await queryRunner.query(`DROP TYPE "persona_prompt_source_enum"`);
  }
}
