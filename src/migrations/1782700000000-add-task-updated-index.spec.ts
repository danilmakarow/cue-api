import { AddTaskUpdatedIndex1782700000000 } from './1782700000000-add-task-updated-index';

/**
 * Runs a migration hook against a stubbed `queryRunner.query`, capturing every
 * SQL statement it issues.
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

describe('AddTaskUpdatedIndex1782700000000', () => {
  it('up creates the composite (calendarId, updatedAt) index', async () => {
    const migration = new AddTaskUpdatedIndex1782700000000();

    const upStatements = await captureStatements((queryRunner) =>
      migration.up(queryRunner as never),
    );

    const composite = upStatements.find((sql) =>
      sql.includes('IDX_task_calendarId_updatedAt'),
    );

    expect(composite).toBeDefined();
    expect(composite).toContain('ON "task" ("calendarId", "updatedAt")');
  });

  it('up does NOT touch IDX_task_recurring_anchor (owned by migration 1781000000000)', async () => {
    const migration = new AddTaskUpdatedIndex1782700000000();

    const upStatements = await captureStatements((queryRunner) =>
      migration.up(queryRunner as never),
    );

    // The recurring-anchor index is dropped+recreated against recurrenceConfig by
    // 1781000000000; recreating it here with the dropped recurrenceRuleId column
    // would abort the boot migration batch (42703). This migration owns only the
    // composite updatedAt index.
    expect(upStatements).toHaveLength(1);
    expect(
      upStatements.some((sql) => sql.includes('IDX_task_recurring_anchor')),
    ).toBe(false);
    expect(
      upStatements.some((sql) => sql.includes('recurrenceRuleId')),
    ).toBe(false);
  });

  it('down drops only the composite index it owns (reversible)', async () => {
    const migration = new AddTaskUpdatedIndex1782700000000();

    const downStatements = await captureStatements((queryRunner) =>
      migration.down(queryRunner as never),
    );

    expect(downStatements).toHaveLength(1);
    expect(downStatements[0]).toContain('DROP INDEX');
    expect(downStatements[0]).toContain('IDX_task_calendarId_updatedAt');
    // Must NOT drop the partial index — that belongs to the earlier migration.
    expect(downStatements[0]).not.toContain('IDX_task_recurring_anchor');
  });
});
