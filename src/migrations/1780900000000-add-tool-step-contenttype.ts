import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the `tool_step` value to `conversation_message_contenttype_enum` so the
 * orchestrator can persist one `role = tool` row per tool-loop round (the tool
 * calls + dispatched results live in `toolPayload`). This turns the previously
 * unused `toolPayload` column into a queryable audit trail for "what did the
 * assistant actually do on that turn".
 *
 * `ADD VALUE` is forward-only: Postgres cannot drop an enum value, so `down` is
 * a deliberate no-op (the unused value is harmless). On PG 15 `ADD VALUE` runs
 * fine inside the migration transaction because the new value is never used in
 * the same transaction.
 */
export class AddToolStepContentType1780900000000 implements MigrationInterface {
  name = 'AddToolStepContentType1780900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."conversation_message_contenttype_enum" ADD VALUE IF NOT EXISTS 'tool_step'`,
    );
  }

  public async down(): Promise<void> {
    // Postgres has no DROP VALUE for enums; leaving 'tool_step' in place is safe
    // and reversible-enough (no rows reference it after a rollback of the code).
  }
}
