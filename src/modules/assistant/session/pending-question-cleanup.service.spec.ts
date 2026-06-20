import { PendingQuestionCleanupService } from './pending-question-cleanup.service';
import {
  PendingQuestion,
  PendingQuestionStatus,
} from '@/modules/database/entities';

/**
 * Builds a {@link PendingQuestionCleanupService} with a mocked DB service,
 * exposing it so each test programs `findExpiredAwaiting` and asserts the sweep's
 * save calls. The cron is invoked directly (the `@Cron` decorator only registers
 * the schedule; the method body is the unit under test).
 */
const buildHarness = () => {
  const pendingQuestionDatabaseService = {
    findExpiredAwaiting: jest.fn().mockResolvedValue([]),
    save: jest.fn(async (entity) => entity),
  };

  const service = new PendingQuestionCleanupService(
    pendingQuestionDatabaseService as never,
  );

  return { service, pendingQuestionDatabaseService };
};

/** Builds an AWAITING pending-question row with the given id. */
const awaitingRow = (id: string): PendingQuestion =>
  ({ id, status: PendingQuestionStatus.AWAITING }) as PendingQuestion;

describe('PendingQuestionCleanupService (ADR 0010 hygiene sweep)', () => {
  it('flips each expired AWAITING row to EXPIRED via save', async () => {
    const { service, pendingQuestionDatabaseService } = buildHarness();

    pendingQuestionDatabaseService.findExpiredAwaiting.mockResolvedValueOnce([
      awaitingRow('pq-1'),
      awaitingRow('pq-2'),
    ]);

    await service.sweepExpired();

    expect(pendingQuestionDatabaseService.save).toHaveBeenCalledTimes(2);

    const savedStatuses = pendingQuestionDatabaseService.save.mock.calls.map(
      ([row]: [PendingQuestion]) => row.status,
    );

    expect(savedStatuses).toEqual([
      PendingQuestionStatus.EXPIRED,
      PendingQuestionStatus.EXPIRED,
    ]);
  });

  it('does nothing when no rows are expired', async () => {
    const { service, pendingQuestionDatabaseService } = buildHarness();

    pendingQuestionDatabaseService.findExpiredAwaiting.mockResolvedValueOnce(
      [],
    );

    await service.sweepExpired();

    expect(pendingQuestionDatabaseService.save).not.toHaveBeenCalled();
  });

  it('skips a row already moved off AWAITING (a concurrent claim) without clobbering it', async () => {
    const { service, pendingQuestionDatabaseService } = buildHarness();
    const claimed = {
      id: 'pq-3',
      status: PendingQuestionStatus.ANSWERED,
    } as PendingQuestion;

    pendingQuestionDatabaseService.findExpiredAwaiting.mockResolvedValueOnce([
      claimed,
    ]);

    await service.sweepExpired();

    expect(pendingQuestionDatabaseService.save).not.toHaveBeenCalled();
  });

  it('never throws when the sweep query fails (scheduler resilience)', async () => {
    const { service, pendingQuestionDatabaseService } = buildHarness();

    pendingQuestionDatabaseService.findExpiredAwaiting.mockRejectedValueOnce(
      new Error('db unreachable'),
    );

    await expect(service.sweepExpired()).resolves.toBeUndefined();
  });
});
