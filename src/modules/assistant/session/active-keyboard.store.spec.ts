import { ActiveKeyboardStore } from './active-keyboard.store';
import { activeKeyboardKey } from '../../redis/redis.constants';
import { KeyboardSurface } from '../reply/reply-keyboard.layout';

/**
 * A tiny in-memory Redis fake covering the surface the active-keyboard store uses:
 * `set` (no TTL), `get`, and `del`. A `fail` toggle simulates a Redis fault so the
 * degrade-never-throw contract is exercised against real per-key storage.
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

const USER = 'user-1';

describe('ActiveKeyboardStore (active reply-keyboard surface)', () => {
  it('sets the active surface and reads it back as the typed enum', async () => {
    const { redis } = buildRedisFake();
    const store = new ActiveKeyboardStore(redis as never, {} as never);

    await store.setActiveSurface(USER, KeyboardSurface.Settings);

    expect(redis.set).toHaveBeenCalledWith(
      activeKeyboardKey(USER),
      KeyboardSurface.Settings,
    );
    await expect(store.getActiveSurface(USER)).resolves.toBe(
      KeyboardSurface.Settings,
    );
  });

  it('returns null when no keyboard is docked (the safe default — no hijack)', async () => {
    const { redis } = buildRedisFake();
    const store = new ActiveKeyboardStore(redis as never, {} as never);

    await expect(store.getActiveSurface(USER)).resolves.toBeNull();
  });

  it('clear removes the flag so a later read returns null', async () => {
    const { redis } = buildRedisFake();
    const store = new ActiveKeyboardStore(redis as never, {} as never);

    await store.setActiveSurface(USER, KeyboardSurface.Main);
    await store.clear(USER);

    expect(redis.del).toHaveBeenCalledWith(activeKeyboardKey(USER));
    await expect(store.getActiveSurface(USER)).resolves.toBeNull();
  });

  it('narrows an unknown stored value to null (a corrupt flag is never an active surface)', async () => {
    const { redis, store: backing } = buildRedisFake();
    const store = new ActiveKeyboardStore(redis as never, {} as never);

    backing.set(activeKeyboardKey(USER), 'garbage');

    await expect(store.getActiveSurface(USER)).resolves.toBeNull();
  });

  it('degrades never-throw: a Redis fault on read resolves null, and set/clear swallow faults', async () => {
    const { redis, fail } = buildRedisFake();
    const store = new ActiveKeyboardStore(redis as never, {} as never);

    fail.get = true;
    fail.set = true;
    fail.del = true;

    await expect(store.getActiveSurface(USER)).resolves.toBeNull();
    await expect(
      store.setActiveSurface(USER, KeyboardSurface.Main),
    ).resolves.toBeUndefined();
    await expect(store.clear(USER)).resolves.toBeUndefined();
  });
});
