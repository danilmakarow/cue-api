import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Extends the inline JSONB `recurrenceConfig` grammar (S3 — advanced monthly
 * recurrence) on both `task` and `task_group` with two additive, optional keys:
 *
 * - `bySetPos` (`number[] | null`) — RFC-5545 BYSETPOS ordinals (1..4 = first..
 *   fourth, -1 = last) selecting the nth match of `byWeekday` within a MONTHLY
 *   period, so "first Monday" / "last Friday" round-trips.
 * - `monthlyAnchor` (`'FIRST_WORKDAY' | 'LAST_WORKDAY' |
 *   'DAY_BEFORE_LAST_WORKDAY' | null`) — a working-day (Mon–Fri) monthly anchor.
 *
 * The column is `jsonb`, so the new keys need NO DDL change — existing rows stay
 * valid (the absent keys read as `null` through the expander's `?? null`
 * normalization). The grammar is enforced at the app layer by the
 * `Create/UpdateRecurrenceRuleDto` validators and the `RecurrenceConfig` type
 * (ADR 0054, inline JSONB recurrence). This migration therefore only refreshes
 * the column COMMENT so the DB self-documents the extended shape; it is fully
 * reversible and touches no row data. No backfill is required: a `null` for
 * either key is the correct "feature unused" value for every existing config.
 */
export class AddAdvancedMonthlyRecurrence1783300000000 implements MigrationInterface {
  name = 'AddAdvancedMonthlyRecurrence1783300000000';

  private static readonly EXTENDED_COMMENT =
    'Inline RFC-5545-lite recurrence config (ADR 0054). MONTHLY selectors: byMonthDay | (byWeekday + bySetPos: nth-weekday, 1..4 / -1=last) | monthlyAnchor (FIRST_WORKDAY | LAST_WORKDAY | DAY_BEFORE_LAST_WORKDAY).';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `COMMENT ON COLUMN "task"."recurrenceConfig" IS '${AddAdvancedMonthlyRecurrence1783300000000.EXTENDED_COMMENT}'`,
    );
    await queryRunner.query(
      `COMMENT ON COLUMN "task_group"."recurrenceConfig" IS '${AddAdvancedMonthlyRecurrence1783300000000.EXTENDED_COMMENT}'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `COMMENT ON COLUMN "task_group"."recurrenceConfig" IS NULL`,
    );
    await queryRunner.query(
      `COMMENT ON COLUMN "task"."recurrenceConfig" IS NULL`,
    );
  }
}
