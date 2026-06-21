import { BufferedMessage, MessageBufferStore } from './message-buffer.store';
import { debounceBufferKey } from '../../redis/redis.constants';
import { InboundKind } from '@/modules/external-vendor/external-vendor.types';

/**
 * A tiny in-memory Redis fake covering exactly the LIST surface the buffer uses:
 * `rpush`/`lpush` (ordered append/prepend), `pexpire` (TTL refresh), and `eval`
 * running the atomic LRANGE+DEL drain script. Modelling real list-order semantics
 * lets arrival-order and atomic-drain be asserted for real rather than via stubs.
 */
const buildRedisFake = () => {
  const lists = new Map<string, string[]>();
  const ttlMs = new Map<string, number>();

  const redis = {
    rpush: jest.fn(
      async (key: string, ...values: string[]): Promise<number> => {
        const list = lists.get(key) ?? [];

        list.push(...values);
        lists.set(key, list);

        return list.length;
      },
    ),
    lpush: jest.fn(
      async (key: string, ...values: string[]): Promise<number> => {
        const list = lists.get(key) ?? [];

        // Real Redis LPUSH inserts each value at the head IN ARGUMENT ORDER, so
        // `LPUSH key a b c` yields `[c, b, a, ...existing]`. Model that exactly so
        // the production reverse() is verified against true Redis semantics.
        for (const value of values) {
          list.unshift(value);
        }

        lists.set(key, list);

        return list.length;
      },
    ),
    pexpire: jest.fn(async (key: string, ms: number): Promise<number> => {
      ttlMs.set(key, ms);

      return 1;
    }),
    // Models the LRANGE+DEL drain script: returns the whole list and clears it.
    eval: jest.fn(
      async (
        _script: string,
        _numKeys: number,
        key: string,
      ): Promise<string[]> => {
        const list = lists.get(key) ?? [];

        lists.delete(key);

        return list;
      },
    ),
  };

  return { redis, lists, ttlMs };
};

const buildStore = () => {
  const { redis, lists, ttlMs } = buildRedisFake();
  const config = {
    debounceWindowMs: 2000,
    debounceQueueAfterMs: 750,
  };
  const store = new MessageBufferStore(redis as never, config as never);

  return { store, redis, lists, ttlMs, config };
};

const message = (
  overrides: Partial<BufferedMessage> = {},
): BufferedMessage => ({
  text: 'hello',
  kind: InboundKind.Text,
  vendorChatId: 'chat-1',
  correlationId: 'cid-1',
  ...overrides,
});

const USER = 'user-1';

describe('MessageBufferStore (debounce buffer, ADR 0042)', () => {
  it('append RPUSHes entries in arrival order under the per-user key + refreshes TTL, and returns the post-append length (FIX 3 seed signal)', async () => {
    const { store, redis } = buildStore();

    // The return is the new list length: 1 for the FIRST (seed) entry, then 2, …
    // The consumer uses `=== 1` to know whether to finalize a non-seed voice surface.
    await expect(store.append(USER, message({ text: 'one' }))).resolves.toBe(1);
    await expect(store.append(USER, message({ text: 'two' }))).resolves.toBe(2);

    const key = debounceBufferKey(USER);

    expect(redis.rpush).toHaveBeenNthCalledWith(
      1,
      key,
      JSON.stringify(message({ text: 'one' })),
    );
    expect(redis.rpush).toHaveBeenNthCalledWith(
      2,
      key,
      JSON.stringify(message({ text: 'two' })),
    );
    expect(redis.pexpire).toHaveBeenCalledWith(key, expect.any(Number));
  });

  it('drain returns every buffered entry in arrival order and clears the list', async () => {
    const { store, lists } = buildStore();

    await store.append(USER, message({ text: 'first' }));
    await store.append(USER, message({ text: 'second' }));
    await store.append(USER, message({ text: 'third' }));

    const drained = await store.drain(USER);

    expect(drained.map((m) => m.text)).toEqual(['first', 'second', 'third']);
    // The list is cleared atomically — a second drain yields nothing (no double-run).
    expect(lists.get(debounceBufferKey(USER))).toBeUndefined();
    expect(await store.drain(USER)).toEqual([]);
  });

  it('drain skips a malformed entry rather than crashing the whole drain', async () => {
    const { store, lists } = buildStore();

    lists.set(debounceBufferKey(USER), [
      JSON.stringify(message({ text: 'good' })),
      '{not json',
      JSON.stringify(message({ text: 'also good' })),
    ]);

    const drained = await store.drain(USER);

    expect(drained.map((m) => m.text)).toEqual(['good', 'also good']);
  });

  it('requeueFront prepends a drained batch ahead of later arrivals (arrival order kept)', async () => {
    const { store } = buildStore();

    // A message arrived during the in-flight turn.
    await store.append(USER, message({ text: 'arrived-during' }));

    // The queue-after path re-buffers the original batch at the FRONT.
    await store.requeueFront(USER, [
      message({ text: 'batch-1' }),
      message({ text: 'batch-2' }),
    ]);

    const drained = await store.drain(USER);

    expect(drained.map((m) => m.text)).toEqual([
      'batch-1',
      'batch-2',
      'arrived-during',
    ]);
  });

  it('requeueFront is a no-op for an empty batch', async () => {
    const { store, redis } = buildStore();

    await store.requeueFront(USER, []);

    expect(redis.lpush).not.toHaveBeenCalled();
  });
});
