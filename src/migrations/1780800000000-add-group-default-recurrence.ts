import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `defaultRecurrenceRuleId` (nullable UUID FK → recurrence_rule.id, ON DELETE SET NULL)
 * to `task_group`, enabling group-level recurrence inheritance: a task with no own
 * recurrence rule inherits the group's default. Additive and reversible.
 */
export class AddGroupDefaultRecurrence1780800000000 implements MigrationInterface {
  name = 'AddGroupDefaultRecurrence1780800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "task_group" ADD COLUMN "defaultRecurrenceRuleId" uuid NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "task_group"
         ADD CONSTRAINT "FK_task_group_defaultRecurrenceRule"
         FOREIGN KEY ("defaultRecurrenceRuleId")
         REFERENCES "recurrence_rule"("id")
         ON DELETE SET NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "task_group"
         DROP CONSTRAINT "FK_task_group_defaultRecurrenceRule"`,
    );
    await queryRunner.query(
      `ALTER TABLE "task_group" DROP COLUMN "defaultRecurrenceRuleId"`,
    );
  }
}
