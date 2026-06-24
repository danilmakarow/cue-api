import { LastMessageLanguageStore } from './last-message-language.store';
import { lastMessageLanguageKey } from '../../redis/redis.constants';

/**
 * A tiny in-memory Redis fake covering the surface the language store uses: `set`
 * with `EX <ttl>` (overwrite, last-write-wins — NO `NX`) and plain `get` (sticky
 * read, NOT `getdel`). A `fail` toggle simulates a Redis fault so the
 * degrade-never-throw contract is exercised against real per-key storage.
 */
const buildRedisFake = () => {
  const store = new Map<string, string>();
  const fail = { set: false, get: false };

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
  };

  return { redis, store, fail };
};

const CONFIG = { lastMessageLanguageTtlSeconds: 604800 };
const USER = 'user-1';

describe('LastMessageLanguageStore (last-message-language tracker, ADR 0055)', () => {
  it('records a locale with the configured TTL and overwrites WITHOUT NX (last-write-wins)', async () => {
    const { redis } = buildRedisFake();
    const store = new LastMessageLanguageStore(redis as never, CONFIG as never);

    await store.record(USER, 'ru');

    expect(redis.set).toHaveBeenCalledWith(
      lastMessageLanguageKey(USER),
      'ru',
      'EX',
      604800,
    );
    // No `NX` flag — the tracker always overwrites the prior language.
    expect(redis.set.mock.calls[0]).toHaveLength(4);
  });

  it('peeks STICKILY: the value survives repeated reads (plain GET, not GETDEL)', async () => {
    const { redis } = buildRedisFake();
    const store = new LastMessageLanguageStore(redis as never, CONFIG as never);

    await store.record(USER, 'uk');

    // Two consecutive peeks BOTH return the value — it is never cleared on read.
    await expect(store.peek(USER)).resolves.toBe('uk');
    await expect(store.peek(USER)).resolves.toBe('uk');
  });

  it('keeps only the latest recorded locale (overwrite-on-write)', async () => {
    const { redis } = buildRedisFake();
    const store = new LastMessageLanguageStore(redis as never, CONFIG as never);

    await store.record(USER, 'ru');
    await store.record(USER, 'en');

    await expect(store.peek(USER)).resolves.toBe('en');
  });

  it('returns null when nothing is tracked', async () => {
    const { redis } = buildRedisFake();
    const store = new LastMessageLanguageStore(redis as never, CONFIG as never);

    await expect(store.peek(USER)).resolves.toBeNull();
  });

  it('rejects a corrupt / legacy stored value (not one of en|uk|ru) as null', async () => {
    const { redis, store: backing } = buildRedisFake();
    const store = new LastMessageLanguageStore(redis as never, CONFIG as never);

    // Simulate a stray / legacy value written outside the typed record() path.
    backing.set(lastMessageLanguageKey(USER), 'fr');

    await expect(store.peek(USER)).resolves.toBeNull();
  });

  it('degrades never-throw: a Redis fault on peek resolves null, and record swallows faults', async () => {
    const { redis, fail } = buildRedisFake();
    const store = new LastMessageLanguageStore(redis as never, CONFIG as never);

    fail.get = true;
    fail.set = true;

    await expect(store.peek(USER)).resolves.toBeNull();
    await expect(store.record(USER, 'ru')).resolves.toBeUndefined();
  });
});
