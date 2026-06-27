import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the `channel` column to `user_report_settings` (backlog S7) — the
 * per-user preferred delivery channel for the daily report. A dedicated
 * `user_report_settings_channel_enum` PG type (`PUSH` | `TELEGRAM`) mirrors the
 * shared `NotificationChannel` enum, following the TypeORM-generated
 * `<table>_<column>_enum` naming used by the other channel columns. Defaults to
 * `TELEGRAM` and is `NOT NULL`, so existing rows backfill to Telegram.
 *
 * NOTE: push delivery is deferred (backlog D1). A `PUSH` value persists but does
 * not deliver today — only Telegram is wired. The column is additive; the
 * scheduler keeps sending via Telegram until the push pipeline lands.
 */
export class AddReportSettingsChannel1783600000000 implements MigrationInterface {
  name = 'AddReportSettingsChannel1783600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."user_report_settings_channel_enum" AS ENUM('PUSH', 'TELEGRAM')`,
    );
    await queryRunner.query(
      `ALTER TABLE "user_report_settings" ADD "channel" "public"."user_report_settings_channel_enum" NOT NULL DEFAULT 'TELEGRAM'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user_report_settings" DROP COLUMN "channel"`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."user_report_settings_channel_enum"`,
    );
  }
}
