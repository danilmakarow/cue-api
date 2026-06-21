import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the `conflict_policy` value to `user_memory_fact_type_enum` (Story 15 /
 * ADR 0011 + 0044) so a user can persist a durable, EXPLICIT standing
 * double-booking policy (`{ policy: 'allow' | 'ask' | 'deny' }`) as a
 * `UserMemoryFact`. The assistant honours an `allow` policy without asking and
 * refuses on a `deny` policy; absent any fact it falls back to default-deny
 * (ask). This is the standing half of the AI-judged-conflict merge gate.
 *
 * `ADD VALUE` is forward-only: Postgres cannot drop an enum value, so `down` is
 * a deliberate no-op (the unused value is harmless and reversible-enough — no
 * rows reference it after a code rollback). `IF NOT EXISTS` makes a re-run safe.
 * On PG 15 `ADD VALUE` runs inside the migration transaction because the new
 * value is never used in the same transaction.
 */
export class AddConflictPolicyFactType1782900000000 implements MigrationInterface {
  name = 'AddConflictPolicyFactType1782900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."user_memory_fact_type_enum" ADD VALUE IF NOT EXISTS 'conflict_policy'`,
    );
  }

  public async down(): Promise<void> {
    // Postgres has no DROP VALUE for enums; leaving 'conflict_policy' in place is
    // safe and reversible-enough (no rows reference it after a code rollback).
  }
}
