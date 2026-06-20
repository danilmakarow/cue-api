import { PendingInteractionService } from './pending-interaction.store';
import { pendingQuestionKey } from '../../redis/redis.constants';
import { PendingQuestion } from '@/modules/database/entities';

/**
 * Builds a {@link PendingInteractionService} with jest mocks for Redis, the
 * assistant config (TTL + retention knobs), and the pending-question DB service,
 * exposing the mocks so each test programs the claim/store behaviour and asserts
 * on the exact Redis + DB calls. The durable claim is the authority; Redis is the
 * hot index, so the two are exercised independently.
 */
const buildHarness = () => {
  const redis = {
    set: jest.fn().mockResolvedValue('OK'),
    getdel: jest.fn().mockResolvedValue(null),
    del: jest.fn().mockResolvedValue(1),
    exists: jest.fn().mockResolvedValue(0),
  };
  const config = {
    askUserTtlSeconds: 1800,
    askUserRetentionHours: 168,
  };
  const pendingQuestionDatabaseService = {
    createInstance: jest.fn((partial) => partial),
    save: jest.fn(async (entity) => ({ id: 'pq-1', ...entity })),
    claimAwaiting: jest.fn(),
  };

  const service = new PendingInteractionService(
    redis as never,
    config as never,
    pendingQuestionDatabaseService as never,
  );

  return { service, redis, config, pendingQuestionDatabaseService };
};

const DRAFT = {
  conversationId: 'conv-1',
  askToolUseId: 'tool-use-1',
  payload: {
    toolRounds: [],
    question: 'Which day?',
    optionLabels: [{ id: 'fri', label: 'Friday' }],
    correlationId: 'cid-1',
    vendorChatId: 'chat-1',
  },
};

describe('PendingInteractionService (ask_user write side, ADR 0010)', () => {
  it('createPendingQuestion writes the durable row then mirrors a hot Redis pointer (value = row id, with TTL)', async () => {
    const { service, redis, pendingQuestionDatabaseService } = buildHarness();

    const saved = await service.createPendingQuestion('user-1', DRAFT);

    expect(saved.id).toBe('pq-1');

    // The row carried the payload, the ask tool-use id, and an expiresAt.
    const created = pendingQuestionDatabaseService.createInstance.mock
      .calls[0][0] as { expiresAt: Date; payload: unknown };

    expect(created.payload).toEqual(DRAFT.payload);
    expect(created.expiresAt).toBeInstanceOf(Date);
    expect(pendingQuestionDatabaseService.save).toHaveBeenCalledTimes(1);

    // The hot pointer is keyed by user, valued with the row id, and TTL'd.
    expect(redis.set).toHaveBeenCalledWith(
      pendingQuestionKey('user-1'),
      'pq-1',
      'EX',
      1800,
    );
  });

  it('createPendingQuestion sets expiresAt to roughly now + retention hours', async () => {
    const { service, pendingQuestionDatabaseService } = buildHarness();
    const before = Date.now();

    await service.createPendingQuestion('user-1', DRAFT);

    const created = pendingQuestionDatabaseService.createInstance.mock
      .calls[0][0] as { expiresAt: Date };
    const expectedMs = before + 168 * 3_600_000;

    // Within a generous 5s window of the computed horizon (clock drift in CI).
    expect(created.expiresAt.getTime()).toBeGreaterThanOrEqual(
      expectedMs - 5_000,
    );
    expect(created.expiresAt.getTime()).toBeLessThanOrEqual(expectedMs + 5_000);
  });

  it('hasPendingQuestion is a cheap Redis EXISTS on the hot key', async () => {
    const { service, redis } = buildHarness();

    redis.exists.mockResolvedValueOnce(1);
    expect(await service.hasPendingQuestion('user-1')).toBe(true);
    expect(redis.exists).toHaveBeenCalledWith(pendingQuestionKey('user-1'));

    redis.exists.mockResolvedValueOnce(0);
    expect(await service.hasPendingQuestion('user-1')).toBe(false);
  });

  it('claimHotByUser GETDELs the hot key then claims that exact row (free-text, in-window)', async () => {
    const { service, redis, pendingQuestionDatabaseService } = buildHarness();
    const row = { id: 'pq-1' } as PendingQuestion;

    redis.getdel.mockResolvedValueOnce('pq-1');
    pendingQuestionDatabaseService.claimAwaiting.mockResolvedValueOnce(row);

    const claimed = await service.claimHotByUser('user-1');

    expect(redis.getdel).toHaveBeenCalledWith(pendingQuestionKey('user-1'));
    expect(pendingQuestionDatabaseService.claimAwaiting).toHaveBeenCalledWith(
      'pq-1',
    );
    expect(claimed).toBe(row);
  });

  it('claimHotByUser returns null without touching the DB when the hot window has lapsed (no key)', async () => {
    const { service, redis, pendingQuestionDatabaseService } = buildHarness();

    redis.getdel.mockResolvedValueOnce(null);

    expect(await service.claimHotByUser('user-1')).toBeNull();
    expect(pendingQuestionDatabaseService.claimAwaiting).not.toHaveBeenCalled();
  });

  it('claimById claims the durable row then clears the hot key (button, works after TTL)', async () => {
    const { service, redis, pendingQuestionDatabaseService } = buildHarness();
    const row = { id: 'pq-9' } as PendingQuestion;

    pendingQuestionDatabaseService.claimAwaiting.mockResolvedValueOnce(row);

    const claimed = await service.claimById('user-1', 'pq-9');

    expect(pendingQuestionDatabaseService.claimAwaiting).toHaveBeenCalledWith(
      'pq-9',
    );
    expect(redis.del).toHaveBeenCalledWith(pendingQuestionKey('user-1'));
    expect(claimed).toBe(row);
  });

  it('claimById returns null and does NOT clear the key when the row was already claimed', async () => {
    const { service, redis, pendingQuestionDatabaseService } = buildHarness();

    pendingQuestionDatabaseService.claimAwaiting.mockResolvedValueOnce(null);

    expect(await service.claimById('user-1', 'pq-9')).toBeNull();
    expect(redis.del).not.toHaveBeenCalled();
  });

  it('double-answer race: only the first claimById wins, the second sees null (compare-and-set)', async () => {
    const { service, pendingQuestionDatabaseService } = buildHarness();
    const row = { id: 'pq-1' } as PendingQuestion;

    // The atomic UPDATE ... WHERE status='AWAITING' RETURNING returns the row
    // exactly once; a concurrent second tap observes zero rows.
    pendingQuestionDatabaseService.claimAwaiting
      .mockResolvedValueOnce(row)
      .mockResolvedValueOnce(null);

    const [first, second] = await Promise.all([
      service.claimById('user-1', 'pq-1'),
      service.claimById('user-1', 'pq-1'),
    ]);

    const wins = [first, second].filter((result) => result !== null);

    expect(wins).toHaveLength(1);
  });
});
