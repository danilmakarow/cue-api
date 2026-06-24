import { LastMenuStore } from './last-menu.store';
import { menuMessageKey } from '../../redis/redis.constants';

/**
 * A tiny in-memory Redis fake covering the surface the last-menu store uses: `set`
 * (no TTL), `getdel` (read-and-clear), and `del`. A `fail` toggle simulates a Redis
 * fault so the degrade-never-throw contract is exercised against real per-key
 * storage.
 */
const buildRedisFake = () => {
  const store = new Map<string, string>();
  const fail = { set: false, getdel: false, del: false };

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

const USER = 'user-1';

describe('LastMenuStore (last-menu-card tracker, ADR 0056)', () => {
  it('records the menu-card id WITHOUT a TTL (durable) and takes it back once', async () => {
    const { redis } = buildRedisFake();
    const store = new LastMenuStore(redis as never);

    await store.record(USER, 'msg-42');

    // Durable: a plain SET with no EX/TTL argument (only key + value).
    expect(redis.set).toHaveBeenCalledWith(menuMessageKey(USER), 'msg-42');
    expect(redis.set.mock.calls[0]).toHaveLength(2);

    await expect(store.take(USER)).resolves.toBe('msg-42');
  });

  it('take is read-and-clear: a second take returns null (consumed exactly once)', async () => {
    const { redis } = buildRedisFake();
    const store = new LastMenuStore(redis as never);

    await store.record(USER, 'msg-7');

    await expect(store.take(USER)).resolves.toBe('msg-7');
    await expect(store.take(USER)).resolves.toBeNull();
    expect(redis.getdel).toHaveBeenCalledWith(menuMessageKey(USER));
  });

  it('overwrites with last-write-wins (only the latest id survives)', async () => {
    const { redis } = buildRedisFake();
    const store = new LastMenuStore(redis as never);

    await store.record(USER, 'msg-old');
    await store.record(USER, 'msg-new');

    await expect(store.take(USER)).resolves.toBe('msg-new');
  });

  it('returns null when nothing is tracked', async () => {
    const { redis } = buildRedisFake();
    const store = new LastMenuStore(redis as never);

    await expect(store.take(USER)).resolves.toBeNull();
  });

  it('clear removes the tracked id so a later take returns null (Logout reset)', async () => {
    const { redis } = buildRedisFake();
    const store = new LastMenuStore(redis as never);

    await store.record(USER, 'msg-9');
    await store.clear(USER);

    expect(redis.del).toHaveBeenCalledWith(menuMessageKey(USER));
    await expect(store.take(USER)).resolves.toBeNull();
  });

  it('degrades never-throw: a Redis fault on take resolves null, and record/clear swallow faults', async () => {
    const { redis, fail } = buildRedisFake();
    const store = new LastMenuStore(redis as never);

    fail.set = true;
    fail.getdel = true;
    fail.del = true;

    await expect(store.take(USER)).resolves.toBeNull();
    await expect(store.record(USER, 'msg-1')).resolves.toBeUndefined();
    await expect(store.clear(USER)).resolves.toBeUndefined();
  });
});
