import { InlineRecurrenceAndEffectiveSettings1781000000000 } from './1781000000000-inline-recurrence-and-effective-settings';

/**
 * Runs a migration hook against a stubbed `queryRunner.query`, capturing every
 * SQL statement it issues so the shape (and ordering) can be asserted without a DB.
 */
const captureStatements = async (
  hook: (queryRunner: {
    query: (sql: string) => Promise<void>;
  }) => Promise<void>,
): Promise<string[]> => {
  const statements: string[] = [];

  await hook({
    query: (sql: string) => {
      statements.push(sql);

      return Promise.resolve();
    },
  });

  return statements;
};

describe('InlineRecurrenceAndEffectiveSettings1781000000000', () => {
  it('up drops the two recurrence FKs before dropping their columns', async () => {
    const migration = new InlineRecurrenceAndEffectiveSettings1781000000000();

    const up = await captureStatements((queryRunner) =>
      migration.up(queryRunner as never),
    );

    const dropTaskFk = up.findIndex((sql) =>
      sql.includes('DROP CONSTRAINT "FK_task_recurrenceRuleId"'),
    );
    const dropTaskCol = up.findIndex((sql) =>
      sql.includes('DROP COLUMN "recurrenceRuleId"'),
    );
    const dropGroupFk = up.findIndex((sql) =>
      sql.includes('DROP CONSTRAINT "FK_task_group_defaultRecurrenceRule"'),
    );
    const dropGroupCol = up.findIndex((sql) =>
      sql.includes('DROP COLUMN "defaultRecurrenceRuleId"'),
    );

    expect(dropTaskFk).toBeGreaterThanOrEqual(0);
    expect(dropTaskFk).toBeLessThan(dropTaskCol);
    expect(dropGroupFk).toBeGreaterThanOrEqual(0);
    expect(dropGroupFk).toBeLessThan(dropGroupCol);
  });

  it('up wipes occurrence exceptions whose anchors lose recurrence', async () => {
    const migration = new InlineRecurrenceAndEffectiveSettings1781000000000();

    const up = await captureStatements((queryRunner) =>
      migration.up(queryRunner as never),
    );

    expect(
      up.some((sql) => sql.includes('DELETE FROM "task_occurrence_exception"')),
    ).toBe(true);
  });

  it('up drops the rule table and its now-unreferenced PG enum types', async () => {
    const migration = new InlineRecurrenceAndEffectiveSettings1781000000000();

    const up = await captureStatements((queryRunner) =>
      migration.up(queryRunner as never),
    );

    expect(up.some((sql) => sql.includes('DROP TABLE "recurrence_rule"'))).toBe(
      true,
    );
    expect(
      up.some((sql) =>
        sql.includes('DROP TYPE "public"."recurrence_rule_endtype_enum"'),
      ),
    ).toBe(true);
    expect(
      up.some((sql) =>
        sql.includes('DROP TYPE "public"."recurrence_rule_frequency_enum"'),
      ),
    ).toBe(true);
  });

  it('up adds the new inline columns and relaxes requiresCompletion', async () => {
    const migration = new InlineRecurrenceAndEffectiveSettings1781000000000();

    const up = await captureStatements((queryRunner) =>
      migration.up(queryRunner as never),
    );

    expect(
      up.some((sql) =>
        sql.includes('ALTER TABLE "task" ADD COLUMN "recurrenceConfig" jsonb'),
      ),
    ).toBe(true);
    expect(
      up.some((sql) =>
        sql.includes('ALTER TABLE "task" ADD COLUMN "color" varchar'),
      ),
    ).toBe(true);
    expect(
      up.some((sql) =>
        sql.includes(
          'ALTER TABLE "task_group" ADD COLUMN "recurrenceConfig" jsonb',
        ),
      ),
    ).toBe(true);
    expect(
      up.some((sql) =>
        sql.includes(
          'ALTER TABLE "task_group" ADD COLUMN "requiresCompletion" boolean',
        ),
      ),
    ).toBe(true);
    expect(
      up.some((sql) =>
        sql.includes(
          'ALTER TABLE "task" ALTER COLUMN "requiresCompletion" DROP DEFAULT',
        ),
      ),
    ).toBe(true);
    expect(
      up.some((sql) =>
        sql.includes(
          'ALTER TABLE "task" ALTER COLUMN "requiresCompletion" DROP NOT NULL',
        ),
      ),
    ).toBe(true);
  });

  it('up recreates the partial recurring-anchor index against recurrenceConfig', async () => {
    const migration = new InlineRecurrenceAndEffectiveSettings1781000000000();

    const up = await captureStatements((queryRunner) =>
      migration.up(queryRunner as never),
    );

    const index = up.find(
      (sql) =>
        sql.includes('CREATE INDEX "IDX_task_recurring_anchor"') &&
        sql.includes('WHERE "recurrenceConfig" IS NOT NULL'),
    );

    expect(index).toBeDefined();
  });

  it('down structurally reverses by recreating the rule table and FKs', async () => {
    const migration = new InlineRecurrenceAndEffectiveSettings1781000000000();

    const down = await captureStatements((queryRunner) =>
      migration.down(queryRunner as never),
    );

    expect(
      down.some((sql) => sql.includes('CREATE TABLE "recurrence_rule"')),
    ).toBe(true);
    expect(
      down.some((sql) =>
        sql.includes('ADD CONSTRAINT "FK_task_recurrenceRuleId"'),
      ),
    ).toBe(true);
    expect(
      down.some((sql) =>
        sql.includes('ADD CONSTRAINT "FK_task_group_defaultRecurrenceRule"'),
      ),
    ).toBe(true);
    // The inlined columns are dropped on the way back.
    expect(
      down.some((sql) =>
        sql.includes('ALTER TABLE "task" DROP COLUMN "recurrenceConfig"'),
      ),
    ).toBe(true);
  });
});
