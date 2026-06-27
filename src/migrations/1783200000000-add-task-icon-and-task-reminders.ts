import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Two additive task/notification changes:
 *
 * - **S4 — per-task icon**: adds a nullable `icon` varchar to `task`, mirroring
 *   the existing `icon` columns on `calendar` and `task_group`.
 * - **S1 — per-task reminders**: lets a `notification_rule` row belong directly
 *   to a `task` (a per-task reminder) instead of only to a strategy. `strategyId`
 *   is relaxed to nullable, a nullable `taskId` FK (ON DELETE CASCADE) is added,
 *   and an index on `taskId` serves the list-by-task / replace-on-update reads.
 *
 * Both are additive and reversible; existing strategy-owned rules are untouched
 * (their `taskId` stays null).
 */
export class AddTaskIconAndTaskReminders1783200000000 implements MigrationInterface {
  name = 'AddTaskIconAndTaskReminders1783200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // S4 — per-task icon.
    await queryRunner.query(
      `ALTER TABLE "task" ADD COLUMN "icon" character varying`,
    );

    // S1 — per-task reminders: relax strategyId, add taskId FK + index.
    await queryRunner.query(
      `ALTER TABLE "notification_rule" ALTER COLUMN "strategyId" DROP NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "notification_rule" ADD COLUMN "taskId" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "notification_rule"
         ADD CONSTRAINT "FK_notification_rule_taskId"
         FOREIGN KEY ("taskId") REFERENCES "task"("id")
         ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_notification_rule_taskId" ON "notification_rule" ("taskId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."IDX_notification_rule_taskId"`,
    );
    await queryRunner.query(
      `ALTER TABLE "notification_rule" DROP CONSTRAINT "FK_notification_rule_taskId"`,
    );
    await queryRunner.query(
      `ALTER TABLE "notification_rule" DROP COLUMN "taskId"`,
    );
    // Restore the NOT NULL on strategyId. Any task-owned (strategyId null) rows
    // must be gone first — they are cascade-deleted with their tasks, and the
    // down path assumes the S1 feature has been fully reverted.
    await queryRunner.query(
      `ALTER TABLE "notification_rule" ALTER COLUMN "strategyId" SET NOT NULL`,
    );

    await queryRunner.query(`ALTER TABLE "task" DROP COLUMN "icon"`);
  }
}
