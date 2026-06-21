import { StopFlagStore } from './stop-flag.store';
import { stopFlagKey } from '../../redis/redis.constants';

/**
 * A tiny in-memory Redis fake covering exactly the surface the STOP-flag store
 * uses: `set` with `EX <ttl>`, `get`, and `del`. Modelling real per-key storage
 * lets the turn-scoping invariant (a flag set for one turn is invisible to another
 * turn's key) be asserted for real rather than via stubbed return values. A
 * `failNext` toggle simulates a Redis fault so the degrade-never-throw contract is
 * exercised.
 */
const buildRedisFake = () => {
  const store = new Map<string, string>();
  const fail = { set: false, get: false, del: false };

  const redis = {
    set: jest.fn(async (key: string, value: string): Promise<'OK'> => {
      if (fail.set) {
        throw new Error('redis set down');
      }

      store.set(key, value);

      return 'OK';
    }),
    get: jest.fn(async (key: string): Promise<string | null> => {
      if (fail.get) {
        throw new Error('redis get down');
      }

      return store.get(key) ?? null;
    }),
    del: jest.fn(async (key: string): Promise<number> => {
      if (fail.del) {
        throw new Error('redis del down');
      }

      const had = store.has(key);

      store.delete(key);

      return had ? 1 : 0;
    }),
  };

  return { redis, store, fail };
};

const CONFIG = { stopFlagTtlSeconds: 300 };
const USER = 'user-1';
const TURN = 'turn-aaa';

describe('StopFlagStore (cooperative STOP flag)', () => {
  it('arms a flag and reports it for the SAME user + turn', async () => {
    const { redis } = buildRedisFake();
    const store = new StopFlagStore(redis as never, CONFIG as never);

    await store.arm(USER, TURN);

    // Stored under the exact per-user/per-turn key with the configured TTL.
    expect(redis.set).toHaveBeenCalledWith(
      stopFlagKey(USER, TURN),
      '1',
      'EX',
      300,
    );
    await expect(store.isStopRequested(USER, TURN)).resolves.toBe(true);
  });

  it('reports false when no flag is set', async () => {
    const { redis } = buildRedisFake();
    const store = new StopFlagStore(redis as never, CONFIG as never);

    await expect(store.isStopRequested(USER, TURN)).resolves.toBe(false);
  });

  it('is TURN-SCOPED: a flag set for one turn is invisible to a different turn (stale flag ignored)', async () => {
    const { redis } = buildRedisFake();
    const store = new StopFlagStore(redis as never, CONFIG as never);

    // STOP was armed for an OLD turn…
    await store.arm(USER, 'turn-old');

    // …a fresh turn (new correlationId) sees no flag — the stale one cannot abort it.
    await expect(store.isStopRequested(USER, 'turn-new')).resolves.toBe(false);
    // The old turn's flag is still its own — proving the keys are independent.
    await expect(store.isStopRequested(USER, 'turn-old')).resolves.toBe(true);
  });

  it('is USER-SCOPED: a flag for one user does not show for another user on the same turn id', async () => {
    const { redis } = buildRedisFake();
    const store = new StopFlagStore(redis as never, CONFIG as never);

    await store.arm('user-a', TURN);

    await expect(store.isStopRequested('user-b', TURN)).resolves.toBe(false);
  });

  it('clear removes the flag so a later check reports false', async () => {
    const { redis } = buildRedisFake();
    const store = new StopFlagStore(redis as never, CONFIG as never);

    await store.arm(USER, TURN);
    await store.clear(USER, TURN);

    expect(redis.del).toHaveBeenCalledWith(stopFlagKey(USER, TURN));
    await expect(store.isStopRequested(USER, TURN)).resolves.toBe(false);
  });

  it('degrades never-throw: a Redis fault on check resolves false (no STOP), and arm/clear swallow faults', async () => {
    const { redis, fail } = buildRedisFake();
    const store = new StopFlagStore(redis as never, CONFIG as never);

    fail.get = true;
    fail.set = true;
    fail.del = true;

    // None of these throw; the check treats a fault as "no STOP requested".
    await expect(store.isStopRequested(USER, TURN)).resolves.toBe(false);
    await expect(store.arm(USER, TURN)).resolves.toBeUndefined();
    await expect(store.clear(USER, TURN)).resolves.toBeUndefined();
  });
});
