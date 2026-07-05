import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the `user_brief_settings` table — the per-user personalization of the
 * daily brief. UUID PK, `timestamptz` audit columns, a UNIQUE `userId` enforcing
 * the 1:1 with `user`, and an FK cascading from `user` so deleting a user reaps
 * the settings row.
 *
 * `customPrompt` is a nullable `text` column holding the user's own instruction,
 * appended to the base daily-brief system prompt when set (it AUGMENTS, never
 * replaces, the base structure/safety/format rules); null means the base prompt
 * is used as-is.
 */
export class AddUserBriefSettings1784000000000 implements MigrationInterface {
  name = 'AddUserBriefSettings1784000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "user_brief_settings" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "userId" uuid NOT NULL,
        "customPrompt" text,
        CONSTRAINT "PK_user_brief_settings_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_user_brief_settings_userId" UNIQUE ("userId")
      )`,
    );
    await queryRunner.query(
      `ALTER TABLE "user_brief_settings" ADD CONSTRAINT "FK_user_brief_settings_userId" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user_brief_settings" DROP CONSTRAINT "FK_user_brief_settings_userId"`,
    );
    await queryRunner.query(`DROP TABLE "user_brief_settings"`);
  }
}
