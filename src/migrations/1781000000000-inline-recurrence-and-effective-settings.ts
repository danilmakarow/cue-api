import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Inlines recurrence onto the row and adds effective-settings columns (ADR 0054).
 *
 * Drops the `recurrence_rule` table and its two FK references (`task.recurrenceRuleId`,
 * `task_group.defaultRecurrenceRuleId`) in favor of a JSONB `recurrenceConfig`
 * column on each of `task` and `task_group`. Also adds `task.color`,
 * `task_group.color` already exists, `task_group.requiresCompletion`, and relaxes
 * `task.requiresCompletion` to a nullable column with NO default (the default now
 * lives in the effective-settings resolver).
 *
 * DATA LOSS: every existing `recurrence_rule` row is destroyed and NOT migrated
 * into the new JSONB column — recurring anchors become one-off rows. Because their
 * recurrence is wiped, their `task_occurrence_exception` rows lose their anchor
 * series and are deleted too. Acceptable: no production data exists yet (greenfield).
 * `down()` reverses the SCHEMA structurally but CANNOT restore the wiped data.
 */
export class InlineRecurrenceAndEffectiveSettings1781000000000 implements MigrationInterface {
  name = 'InlineRecurrenceAndEffectiveSettings1781000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Drop the two FKs into recurrence_rule before dropping the table/columns.
    await queryRunner.query(
      `ALTER TABLE "task" DROP CONSTRAINT "FK_task_recurrenceRuleId"`,
    );
    await queryRunner.query(
      `ALTER TABLE "task_group" DROP CONSTRAINT "FK_task_group_defaultRecurrenceRule"`,
    );

    // The old partial index references the column we are about to drop.
    await queryRunner.query(`DROP INDEX "public"."IDX_task_recurring_anchor"`);

    // Wipe per-occurrence exceptions: their anchor series lose recurrence on the
    // table drop, so the exception rows are orphaned and must go too.
    await queryRunner.query(`DELETE FROM "task_occurrence_exception"`);

    // Drop the now-unreferenced FK columns and the rule table.
    await queryRunner.query(
      `ALTER TABLE "task" DROP COLUMN "recurrenceRuleId"`,
    );
    await queryRunner.query(
      `ALTER TABLE "task_group" DROP COLUMN "defaultRecurrenceRuleId"`,
    );
    await queryRunner.query(`DROP TABLE "recurrence_rule"`);

    // The rule table owned these PG enum types; nothing references them now.
    await queryRunner.query(
      `DROP TYPE "public"."recurrence_rule_endtype_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."recurrence_rule_frequency_enum"`,
    );

    // Inline recurrence config + new effective-settings columns.
    await queryRunner.query(
      `ALTER TABLE "task" ADD COLUMN "recurrenceConfig" jsonb`,
    );
    await queryRunner.query(`ALTER TABLE "task" ADD COLUMN "color" varchar`);
    await queryRunner.query(
      `ALTER TABLE "task_group" ADD COLUMN "recurrenceConfig" jsonb`,
    );
    await queryRunner.query(
      `ALTER TABLE "task_group" ADD COLUMN "requiresCompletion" boolean`,
    );

    // requiresCompletion is now nullable with no default — the default (false)
    // lives in the resolver, not the column.
    await queryRunner.query(
      `ALTER TABLE "task" ALTER COLUMN "requiresCompletion" DROP DEFAULT`,
    );
    await queryRunner.query(
      `ALTER TABLE "task" ALTER COLUMN "requiresCompletion" DROP NOT NULL`,
    );

    // Recreate the recurring-anchor partial index against the new JSONB column.
    await queryRunner.query(
      `CREATE INDEX "IDX_task_recurring_anchor" ON "task" ("calendarId") WHERE "recurrenceConfig" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reverse the index first (it targets the JSONB column we drop below).
    await queryRunner.query(`DROP INDEX "public"."IDX_task_recurring_anchor"`);

    // Restore the column constraints (cannot restore wiped data — see class doc).
    await queryRunner.query(
      `ALTER TABLE "task" ALTER COLUMN "requiresCompletion" SET NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "task" ALTER COLUMN "requiresCompletion" SET DEFAULT true`,
    );

    // Drop the inlined columns.
    await queryRunner.query(
      `ALTER TABLE "task_group" DROP COLUMN "requiresCompletion"`,
    );
    await queryRunner.query(
      `ALTER TABLE "task_group" DROP COLUMN "recurrenceConfig"`,
    );
    await queryRunner.query(`ALTER TABLE "task" DROP COLUMN "color"`);
    await queryRunner.query(
      `ALTER TABLE "task" DROP COLUMN "recurrenceConfig"`,
    );

    // Recreate the PG enum types the rule table used.
    await queryRunner.query(
      `CREATE TYPE "public"."recurrence_rule_frequency_enum" AS ENUM('DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."recurrence_rule_endtype_enum" AS ENUM('NEVER', 'UNTIL_DATE', 'COUNT')`,
    );

    // Recreate the recurrence_rule table (structure only).
    await queryRunner.query(
      `CREATE TABLE "recurrence_rule" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "frequency" "public"."recurrence_rule_frequency_enum" NOT NULL,
        "interval" integer NOT NULL DEFAULT 1,
        "byWeekday" integer array,
        "byMonthDay" integer array,
        "byMonth" integer array,
        "endType" "public"."recurrence_rule_endtype_enum" NOT NULL DEFAULT 'NEVER',
        "endDate" date,
        "count" integer,
        CONSTRAINT "PK_recurrence_rule_id" PRIMARY KEY ("id")
      )`,
    );

    // Recreate the FK columns and their constraints.
    await queryRunner.query(
      `ALTER TABLE "task" ADD COLUMN "recurrenceRuleId" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "task_group" ADD COLUMN "defaultRecurrenceRuleId" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "task" ADD CONSTRAINT "FK_task_recurrenceRuleId" FOREIGN KEY ("recurrenceRuleId") REFERENCES "recurrence_rule"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "task_group"
         ADD CONSTRAINT "FK_task_group_defaultRecurrenceRule"
         FOREIGN KEY ("defaultRecurrenceRuleId")
         REFERENCES "recurrence_rule"("id")
         ON DELETE SET NULL`,
    );

    // Recreate the original partial index against the restored FK column.
    await queryRunner.query(
      `CREATE INDEX "IDX_task_recurring_anchor" ON "task" ("calendarId") WHERE "recurrenceRuleId" IS NOT NULL`,
    );
  }
}
