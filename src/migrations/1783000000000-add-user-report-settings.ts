import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the `user_report_settings` table (Story 17 / ADR 0046) — the per-user
 * opt-in, local send time, and last-sent-date idempotency guard for the daily
 * notification report. UUID PK, `timestamptz` audit columns, a UNIQUE `userId`
 * enforcing the 1:1 with `user`, and an FK cascading from `user` so deleting a
 * user reaps the settings row.
 *
 * `reportTimeLocal` is a wall-clock `HH:mm` string (interpreted in the user's
 * `User.timezone`, NOT a timestamp); `lastSentLocalDate` is the user's local
 * `YYYY-MM-DD` the last report was sent for (nullable until the first send).
 * The `enabled` btree index backs the per-minute scheduler's opted-in scan.
 */
export class AddUserReportSettings1783000000000 implements MigrationInterface {
  name = 'AddUserReportSettings1783000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "user_report_settings" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "userId" uuid NOT NULL,
        "enabled" boolean NOT NULL DEFAULT false,
        "reportTimeLocal" character varying(5) NOT NULL DEFAULT '08:00',
        "lastSentLocalDate" character varying,
        CONSTRAINT "PK_user_report_settings_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_user_report_settings_userId" UNIQUE ("userId")
      )`,
    );
    await queryRunner.query(
      `ALTER TABLE "user_report_settings" ADD CONSTRAINT "FK_user_report_settings_userId" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    // Per-minute scheduler scans only opted-in rows.
    await queryRunner.query(
      `CREATE INDEX "IDX_user_report_settings_enabled" ON "user_report_settings" ("enabled")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."IDX_user_report_settings_enabled"`,
    );
    await queryRunner.query(
      `ALTER TABLE "user_report_settings" DROP CONSTRAINT "FK_user_report_settings_userId"`,
    );
    await queryRunner.query(`DROP TABLE "user_report_settings"`);
  }
}
