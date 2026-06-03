import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds a partial index on `task (calendarId) WHERE recurrenceRuleId IS NOT NULL`
 * so the occurrence-aware range read can fetch "all recurring anchors for a
 * calendar" without scanning every task row (a recurring anchor's `startAt`
 * tells us nothing about whether it hits the query window, so every anchor must
 * be considered). Additive and reversible; no backfill.
 */
export class AddRecurringTaskIndex1780700000000 implements MigrationInterface {
  name = 'AddRecurringTaskIndex1780700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX "IDX_task_recurring_anchor" ON "task" ("calendarId") WHERE "recurrenceRuleId" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_task_recurring_anchor"`);
  }
}
