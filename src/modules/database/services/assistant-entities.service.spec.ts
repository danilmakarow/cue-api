import { ConversationDatabaseService } from './conversation-database.service';
import { ConversationMessageDatabaseService } from './conversation-message-database.service';
import { ConversationSummaryDatabaseService } from './conversation-summary-database.service';
import { UserMemoryFactDatabaseService } from './user-memory-fact-database.service';
import { AddAssistantConversationMemory1780268445123 } from '../../../migrations/1780268445123-add-assistant-conversation-memory';

/**
 * Builds a repository stub exposing only the read helpers the assistant
 * DatabaseServices call, so each service can be constructed and exercised
 * without a live DataSource. Cast at the construction site (`as never`) since the
 * concrete repository parameter types are invariant.
 */
const repositoryStub = () => ({
  findOneBy: jest.fn().mockResolvedValue(null),
  findOne: jest.fn().mockResolvedValue(null),
  find: jest.fn().mockResolvedValue([]),
  findBy: jest.fn().mockResolvedValue([]),
});

describe('Assistant DatabaseServices', () => {
  it('construct and expose their custom finders', async () => {
    const conversation = new ConversationDatabaseService(
      repositoryStub() as never,
    );
    const messages = new ConversationMessageDatabaseService(
      repositoryStub() as never,
    );
    const summaries = new ConversationSummaryDatabaseService(
      repositoryStub() as never,
    );
    const facts = new UserMemoryFactDatabaseService(repositoryStub() as never);

    expect(await conversation.findByUserId('user-1')).toBeNull();
    expect(await messages.findRecentWindow('conv-1', 10)).toEqual([]);
    expect(await messages.countInConversation('conv-1')).toBe(0);
    expect(await summaries.findLatest('conv-1')).toBeNull();
    expect(
      await facts.findByNaturalKey('user-1', 'preference' as never, 'gym'),
    ).toBeNull();
    expect(await facts.findAllByUserId('user-1')).toEqual([]);
  });

  it('returns the recent window oldest-first (reverses the newest-first read)', async () => {
    const repository = repositoryStub();

    repository.find.mockResolvedValue([
      { id: 'newest' },
      { id: 'middle' },
      { id: 'oldest' },
    ]);

    const messages = new ConversationMessageDatabaseService(
      repository as never,
    );

    const window = await messages.findRecentWindow('conv-1', 3);

    expect(window.map((message) => message.id)).toEqual([
      'oldest',
      'middle',
      'newest',
    ]);
  });

  it('is reversible: up creates and down drops the four tables symmetrically', async () => {
    const migration = new AddAssistantConversationMemory1780268445123();
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
    ).toHaveLength(4);
    expect(
      downStatements.filter((sql) => sql.includes('DROP TABLE')),
    ).toHaveLength(4);
    expect(
      upStatements.filter((sql) => sql.includes('CREATE TYPE')),
    ).toHaveLength(4);
    expect(
      downStatements.filter((sql) => sql.includes('DROP TYPE')),
    ).toHaveLength(4);
  });
});
