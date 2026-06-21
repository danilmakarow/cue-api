import { Job } from 'bullmq';

import { DebounceQueueJob } from './assistant.types';
import { DebounceConsumer } from './debounce.consumer';
import { DebounceCoordinatorService } from './session/debounce-coordinator.service';
import { User } from '@/modules/database/entities';
import { UserDatabaseService } from '@/modules/database/services';

const buildJob = (userId: string): Job<DebounceQueueJob> =>
  ({ id: `debounce:${userId}`, data: { userId } }) as Job<DebounceQueueJob>;

const buildConsumer = (user: User | null) => {
  const userDatabaseService = {
    findOneBy: jest.fn().mockResolvedValue(user),
  } as unknown as jest.Mocked<UserDatabaseService>;
  const coordinator = {
    drainAndRun: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<DebounceCoordinatorService>;

  const consumer = new DebounceConsumer(userDatabaseService, coordinator);

  return { consumer, userDatabaseService, coordinator };
};

describe('DebounceConsumer (Story 14a / ADR 0042)', () => {
  it('resolves the user and hands off to the coordinator drain with the job data (so an answer re-poll is dispatched)', async () => {
    const user = { id: 'user-1', timezone: 'UTC' } as User;
    const { consumer, coordinator } = buildConsumer(user);

    await consumer.process(buildJob('user-1'));

    // The job DATA rides through so the coordinator can branch on `job.answer`
    // (a queued-after `ask_user` answer re-poll) vs a plain simple-message drain.
    expect(coordinator.drainAndRun).toHaveBeenCalledWith(user, {
      userId: 'user-1',
    });
  });

  it('hands an answer-carrying job through to the coordinator (queued-after ask_user re-poll)', async () => {
    const user = { id: 'user-1', timezone: 'UTC' } as User;
    const { consumer, coordinator } = buildConsumer(user);
    const answerJob = {
      id: 'debounce-after-user-1-abc',
      data: {
        userId: 'user-1',
        answer: {
          text: 'Tuesday',
          kind: 'text',
          vendorChatId: 'chat-1',
          correlationId: 'cid-answer',
          origin: 'answer_callback',
          callbackId: 'cb-1',
        },
      },
    } as unknown as Job<DebounceQueueJob>;

    await consumer.process(answerJob);

    expect(coordinator.drainAndRun).toHaveBeenCalledWith(user, answerJob.data);
  });

  it('is a no-op for a vanished user (buffer left intact, no drain)', async () => {
    const { consumer, coordinator } = buildConsumer(null);

    await consumer.process(buildJob('ghost'));

    expect(coordinator.drainAndRun).not.toHaveBeenCalled();
  });
});
