import { AddRecurringTaskIndex1780700000000 } from './1780700000000-add-recurring-task-index';

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

describe('AddRecurringTaskIndex1780700000000', () => {
  it('up creates the partial recurring-anchor index on task(calendarId)', async () => {
    const migration = new AddRecurringTaskIndex1780700000000();

    const upStatements = await captureStatements((queryRunner) =>
      migration.up(queryRunner as never),
    );

    expect(upStatements).toHaveLength(1);
    expect(upStatements[0]).toContain(
      'CREATE INDEX "IDX_task_recurring_anchor"',
    );
    expect(upStatements[0]).toContain('ON "task" ("calendarId")');
    expect(upStatements[0]).toContain('WHERE "recurrenceRuleId" IS NOT NULL');
  });

  it('down drops the index it created (reversible)', async () => {
    const migration = new AddRecurringTaskIndex1780700000000();

    const downStatements = await captureStatements((queryRunner) =>
      migration.down(queryRunner as never),
    );

    expect(downStatements).toHaveLength(1);
    expect(downStatements[0]).toContain('DROP INDEX');
    expect(downStatements[0]).toContain('IDX_task_recurring_anchor');
  });

  it('is symmetric: exactly one create up and one drop down', async () => {
    const migration = new AddRecurringTaskIndex1780700000000();

    const upStatements = await captureStatements((queryRunner) =>
      migration.up(queryRunner as never),
    );
    const downStatements = await captureStatements((queryRunner) =>
      migration.down(queryRunner as never),
    );

    expect(
      upStatements.filter((sql) => sql.includes('CREATE INDEX')),
    ).toHaveLength(1);
    expect(
      downStatements.filter((sql) => sql.includes('DROP INDEX')),
    ).toHaveLength(1);
  });
});
