import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds per-occurrence OVERRIDE support to `task` (the materialized-override-task
 * model). An override is a real one-off task linked to its recurring parent by
 * `(parentTaskId, originalStartAt)` — the iCalendar RECURRENCE-ID pattern.
 *
 * - `parentTaskId` FK → `task(id)` ON DELETE SET NULL: a hard-delete safety net
 *   (Task is normally soft-deleted; a calendar CASCADE hard-deletes tasks, and
 *   degrading a child to standalone beats silent destruction).
 * - `originalStartAt`: the pre-override generated instant this child replaces.
 * - `detachedAt`: set when the parent rule no longer generates that instant.
 * - `recurrenceUpdatedAt`: client discriminator for "re-expansion needed".
 *
 * The CHECK is deliberately ONE-DIRECTIONAL (`parentTaskId IS NULL OR
 * originalStartAt IS NOT NULL`): the FK's SET NULL must be able to orphan a child
 * (null parentTaskId, retained originalStartAt) without the referential action
 * itself tripping the constraint and aborting the parent DELETE. The reverse
 * (originalStartAt without parentTaskId) is legal inert residue.
 *
 * The partial unique index enforces one LIVE override per slot while allowing a
 * new override after a soft-deleted revert.
 */
export class AddOverrideTaskColumns1783900000000 implements MigrationInterface {
  name = 'AddOverrideTaskColumns1783900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "task"
        ADD "parentTaskId" uuid,
        ADD "originalStartAt" TIMESTAMP WITH TIME ZONE,
        ADD "detachedAt" TIMESTAMP WITH TIME ZONE,
        ADD "recurrenceUpdatedAt" TIMESTAMP WITH TIME ZONE
    `);

    await queryRunner.query(`
      ALTER TABLE "task"
        ADD CONSTRAINT "FK_task_parentTask" FOREIGN KEY ("parentTaskId")
          REFERENCES "task"("id") ON DELETE SET NULL ON UPDATE NO ACTION
    `);

    await queryRunner.query(`
      ALTER TABLE "task"
        ADD CONSTRAINT "CHK_task_override_pair"
          CHECK ("parentTaskId" IS NULL OR "originalStartAt" IS NOT NULL)
    `);

    // One LIVE override per (parent, slot); scoped to deletedAt IS NULL so a
    // soft-deleted revert can be re-overridden later.
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_task_override_slot"
        ON "task" ("parentTaskId", "originalStartAt")
        WHERE "parentTaskId" IS NOT NULL AND "deletedAt" IS NULL
    `);

    // Child lookups (suppression, cascade, detach sweep).
    await queryRunner.query(`
      CREATE INDEX "IDX_task_parentTaskId"
        ON "task" ("parentTaskId")
        WHERE "parentTaskId" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_task_parentTaskId"`);
    await queryRunner.query(`DROP INDEX "UQ_task_override_slot"`);
    await queryRunner.query(
      `ALTER TABLE "task" DROP CONSTRAINT "CHK_task_override_pair"`,
    );
    await queryRunner.query(
      `ALTER TABLE "task" DROP CONSTRAINT "FK_task_parentTask"`,
    );
    await queryRunner.query(`
      ALTER TABLE "task"
        DROP COLUMN "recurrenceUpdatedAt",
        DROP COLUMN "detachedAt",
        DROP COLUMN "originalStartAt",
        DROP COLUMN "parentTaskId"
    `);
  }
}
