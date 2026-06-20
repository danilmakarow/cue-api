import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds a composite index on `task (calendarId, updatedAt)` so the delta read
 * (`GET /tasks/changes`) — which filters `calendarId = ? AND updatedAt > ?` and
 * orders by `updatedAt` — can range-scan a single calendar's changed rows
 * instead of scanning every task. The existing partial recurring-anchor index
 * is created defensively here too (guarded by IF NOT EXISTS) in case an
 * environment predates `AddRecurringTaskIndex1780700000000`.
 *
 * Additive, reversible, no backfill. Perf-only — the endpoint is correct
 * without it; run `migration:run` when ready.
 */
export class AddTaskUpdatedIndex1782700000000 implements MigrationInterface {
  name = 'AddTaskUpdatedIndex1782700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_task_calendarId_updatedAt" ON "task" ("calendarId", "updatedAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_task_recurring_anchor" ON "task" ("calendarId") WHERE "recurrenceRuleId" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_task_calendarId_updatedAt"`,
    );
  }
}
