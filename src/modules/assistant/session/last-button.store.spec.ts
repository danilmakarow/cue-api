import { LastButtonStore } from './last-button.store';
import { lastButtonKey } from '../../redis/redis.constants';

/**
 * A tiny in-memory Redis fake covering the surface the last-button store uses:
 * `set` with `EX <ttl>` and `getdel` (atomic read-then-clear). A `fail` toggle
 * simulates a Redis fault so the degrade-never-throw contract is exercised against
 * real per-key storage.
 */
const buildRedisFake = () => {
  const store = new Map<string, string>();
  const fail = { set: false, getdel: false };

  const redis = {
    set: jest.fn(async (key: string, value: string): Promise<'OK'> => {
      if (fail.set) {
        throw new Error('redis set down');
      }

      store.set(key, value);

      return 'OK';
    }),
    getdel: jest.fn(async (key: string): Promise<string | null> => {
      if (fail.getdel) {
        throw new Error('redis getdel down');
      }

      const value = store.get(key) ?? null;

      store.delete(key);

      return value;
    }),
  };

  return { redis, store, fail };
};

const CONFIG = { lastButtonTtlSeconds: 300 };
const USER = 'user-1';

describe('LastButtonStore (latest reply-keyboard result)', () => {
  it('records a line with the configured TTL and takes it back once (read-then-clear)', async () => {
    const { redis } = buildRedisFake();
    const store = new LastButtonStore(redis as never, CONFIG as never);

    await store.record(USER, "Showed today's schedule.");

    expect(redis.set).toHaveBeenCalledWith(
      lastButtonKey(USER),
      "Showed today's schedule.",
      'EX',
      300,
    );

    // First take returns the line; the second is null — a one-shot nudge.
    await expect(store.takeLatest(USER)).resolves.toBe(
      "Showed today's schedule.",
    );
    await expect(store.takeLatest(USER)).resolves.toBeNull();
  });

  it('overwrites a prior unconsumed line (only the latest button survives)', async () => {
    const { redis } = buildRedisFake();
    const store = new LastButtonStore(redis as never, CONFIG as never);

    await store.record(USER, 'Opened Settings.');
    await store.record(USER, 'Returned to the main menu.');

    await expect(store.takeLatest(USER)).resolves.toBe(
      'Returned to the main menu.',
    );
  });

  it('returns null when nothing is pending', async () => {
    const { redis } = buildRedisFake();
    const store = new LastButtonStore(redis as never, CONFIG as never);

    await expect(store.takeLatest(USER)).resolves.toBeNull();
  });

  it('degrades never-throw: a Redis fault on take resolves null, and record swallows faults', async () => {
    const { redis, fail } = buildRedisFake();
    const store = new LastButtonStore(redis as never, CONFIG as never);

    fail.getdel = true;
    fail.set = true;

    await expect(store.takeLatest(USER)).resolves.toBeNull();
    await expect(store.record(USER, 'anything')).resolves.toBeUndefined();
  });
});
