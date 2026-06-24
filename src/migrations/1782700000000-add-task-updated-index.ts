import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds a composite index on `task (calendarId, updatedAt)` so the delta read
 * (`GET /tasks/changes`) — which filters `calendarId = ? AND updatedAt > ?` and
 * orders by `updatedAt` — can range-scan a single calendar's changed rows
 * instead of scanning every task.
 *
 * Additive, reversible, no backfill. Perf-only — the endpoint is correct
 * without it; run `migration:run` when ready.
 *
 * NOTE: the partial recurring-anchor index (`IDX_task_recurring_anchor`) is
 * owned by `InlineRecurrenceAndEffectiveSettings1781000000000`, which drops the
 * legacy `recurrenceRuleId` column and (re)creates that index against
 * `recurrenceConfig`. This migration runs AFTER it, so it must NOT recreate the
 * index here: a `WHERE "recurrenceRuleId" ...` predicate references a
 * now-dropped column and Postgres validates the predicate before the
 * `IF NOT EXISTS` name short-circuit, aborting the whole boot migration batch.
 */
export class AddTaskUpdatedIndex1782700000000 implements MigrationInterface {
  name = 'AddTaskUpdatedIndex1782700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_task_calendarId_updatedAt" ON "task" ("calendarId", "updatedAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_task_calendarId_updatedAt"`,
    );
  }
}
