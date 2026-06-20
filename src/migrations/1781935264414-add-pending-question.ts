import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the `pending_question` table (ADR 0010) — the durable store for a
 * suspended `ask_user` turn (system of record, mirrored to Redis with a TTL).
 * UUID PK, `timestamptz` columns, the `<table>_<column>_enum` status type, and a
 * FK cascading from `conversation` so deleting a thread reaps its pending rows.
 *
 * Two indexes back ADR 0010's invariants:
 * - a PARTIAL UNIQUE index on `conversationId WHERE status = 'AWAITING'` enforces
 *   at most one open question per conversation (the rest of the lifecycle states
 *   may co-exist as history);
 * - a `(status, expiresAt)` btree index serves the `@nestjs/schedule` cleanup
 *   sweep that expires stale `AWAITING` rows.
 */
export class AddPendingQuestion1781935264414 implements MigrationInterface {
  name = 'AddPendingQuestion1781935264414';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."pending_question_status_enum" AS ENUM('AWAITING', 'ANSWERED', 'CANCELLED', 'EXPIRED')`,
    );

    await queryRunner.query(
      `CREATE TABLE "pending_question" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "conversationId" uuid NOT NULL,
        "askToolUseId" text NOT NULL,
        "payload" jsonb NOT NULL,
        "status" "public"."pending_question_status_enum" NOT NULL DEFAULT 'AWAITING',
        "expiresAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        CONSTRAINT "PK_pending_question_id" PRIMARY KEY ("id")
      )`,
    );
    await queryRunner.query(
      `ALTER TABLE "pending_question" ADD CONSTRAINT "FK_pending_question_conversationId" FOREIGN KEY ("conversationId") REFERENCES "conversation"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );

    // At most one open question per conversation (the partial unique invariant).
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_pending_question_conversationId_awaiting" ON "pending_question" ("conversationId") WHERE "status" = 'AWAITING'`,
    );
    // Cleanup sweep: scan AWAITING rows past their expiry, oldest first.
    await queryRunner.query(
      `CREATE INDEX "IDX_pending_question_status_expiresAt" ON "pending_question" ("status", "expiresAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."IDX_pending_question_status_expiresAt"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."UQ_pending_question_conversationId_awaiting"`,
    );
    await queryRunner.query(
      `ALTER TABLE "pending_question" DROP CONSTRAINT "FK_pending_question_conversationId"`,
    );
    await queryRunner.query(`DROP TABLE "pending_question"`);
    await queryRunner.query(
      `DROP TYPE "public"."pending_question_status_enum"`,
    );
  }
}
