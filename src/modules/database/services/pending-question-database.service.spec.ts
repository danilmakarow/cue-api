import { PendingQuestionDatabaseService } from './pending-question-database.service';
import { AddPendingQuestion1781935264414 } from '../../../migrations/1781935264414-add-pending-question';
import { PendingQuestionStatus } from '../entities';

/**
 * Builds a repository stub exposing the read helpers plus a chainable
 * `createQueryBuilder` so the service can be constructed and its finders +
 * atomic claim exercised without a live DataSource. `executeResult` seeds the
 * `RETURNING *` rows the claim observes. Cast at the construction site
 * (`as never`) since the concrete repository parameter types are invariant.
 */
const repositoryStub = (executeResult: unknown[] = []) => {
  const queryBuilder = {
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    returning: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({ raw: executeResult }),
  };

  return {
    findOneBy: jest.fn().mockResolvedValue(null),
    findOne: jest.fn().mockResolvedValue(null),
    find: jest.fn().mockResolvedValue([]),
    findBy: jest.fn().mockResolvedValue([]),
    createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
  };
};

describe('PendingQuestionDatabaseService', () => {
  it('constructs and exposes its custom finders', async () => {
    const service = new PendingQuestionDatabaseService(
      repositoryStub() as never,
    );

    expect(await service.findAwaitingByConversation('conv-1')).toBeNull();
    expect(await service.findExpiredAwaiting(new Date(), 100)).toEqual([]);
  });

  it('findAwaitingByConversation queries the single open row by status', async () => {
    const repository = repositoryStub();
    const service = new PendingQuestionDatabaseService(repository as never);

    await service.findAwaitingByConversation('conv-1');

    expect(repository.findOneBy).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      status: PendingQuestionStatus.AWAITING,
    });
  });

  it('claimAwaiting returns the row when the compare-and-set wins', async () => {
    const row = { id: 'pq-1', status: PendingQuestionStatus.ANSWERED };
    const service = new PendingQuestionDatabaseService(
      repositoryStub([row]) as never,
    );

    const claimed = await service.claimAwaiting('pq-1');

    expect(claimed).toEqual(row);
  });

  it('claimAwaiting returns null when the row was already claimed (zero rows)', async () => {
    const service = new PendingQuestionDatabaseService(
      repositoryStub([]) as never,
    );

    const claimed = await service.claimAwaiting('pq-1');

    expect(claimed).toBeNull();
  });

  it('claimAwaiting flips AWAITING → ANSWERED guarded by the status predicate', async () => {
    const repository = repositoryStub([{ id: 'pq-1' }]);
    const service = new PendingQuestionDatabaseService(repository as never);

    await service.claimAwaiting('pq-1');

    const queryBuilder = repository.createQueryBuilder.mock.results[0]
      .value as Record<string, jest.Mock>;

    expect(queryBuilder.set).toHaveBeenCalledWith({
      status: PendingQuestionStatus.ANSWERED,
    });
    expect(queryBuilder.where).toHaveBeenCalledWith('id = :id', { id: 'pq-1' });
    expect(queryBuilder.andWhere).toHaveBeenCalledWith('status = :awaiting', {
      awaiting: PendingQuestionStatus.AWAITING,
    });
    expect(queryBuilder.returning).toHaveBeenCalledWith('*');
  });

  it('migration is reversible: up creates the table/type/indexes, down drops them', async () => {
    const migration = new AddPendingQuestion1781935264414();
    const upStatements: string[] = [];
    const downStatements: string[] = [];

    await migration.up({
      query: (sql: string) => {
        upStatements.push(sql);

        return Promise.resolve();
      },
    } as never);
    await migration.down({
      query: (sql: string) => {
        downStatements.push(sql);

        return Promise.resolve();
      },
    } as never);

    expect(
      upStatements.filter((sql) => sql.includes('CREATE TABLE')),
    ).toHaveLength(1);
    expect(
      downStatements.filter((sql) => sql.includes('DROP TABLE')),
    ).toHaveLength(1);
    expect(
      upStatements.filter((sql) => sql.includes('CREATE TYPE')),
    ).toHaveLength(1);
    expect(
      downStatements.filter((sql) => sql.includes('DROP TYPE')),
    ).toHaveLength(1);
    expect(
      upStatements.filter((sql) => sql.includes('CREATE UNIQUE INDEX')),
    ).toHaveLength(1);
    expect(
      upStatements.some((sql) => sql.includes('WHERE "status" = \'AWAITING\'')),
    ).toBe(true);
  });
});
