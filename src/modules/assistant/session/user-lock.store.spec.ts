import { UserLockStore } from './user-lock.store';
import { userLockKey } from '../../redis/redis.constants';

/**
 * A tiny in-memory Redis fake covering exactly the surface the lock uses:
 * `set` with `PX <ttlMs>` + `NX` (the atomic acquire), and `eval` running the
 * two token-checked Lua scripts (compare-and-del release, compare-and-pexpire
 * renew) against the same map. Modelling real `SET NX` + token-compare semantics
 * lets the acquire race and the "only the holder releases" rule be asserted for
 * real rather than via stubbed return values. TTL is tracked so auto-expiry can
 * be simulated by `expireKey`.
 */
const buildRedisFake = () => {
  const store = new Map<string, string>();
  const ttlMs = new Map<string, number>();

  const redis = {
    set: jest.fn(
      async (
        key: string,
        value: string,
        ...rest: unknown[]
      ): Promise<'OK' | null> => {
        const hasNx = rest.includes('NX');

        if (hasNx && store.has(key)) {
          return null;
        }

        store.set(key, value);

        const pxIndex = rest.indexOf('PX');

        if (pxIndex >= 0) {
          ttlMs.set(key, rest[pxIndex + 1] as number);
        }

        return 'OK';
      },
    ),
    // Models the two Lua scripts by their KEYS[1]/ARGV[1] contract: both compare
    // the stored value to the token before mutating.
    eval: jest.fn(
      async (
        script: string,
        _numKeys: number,
        key: string,
        token: string,
        newTtl?: string,
      ): Promise<number> => {
        if (store.get(key) !== token) {
          return 0;
        }

        if (script.includes('del')) {
          store.delete(key);
          ttlMs.delete(key);

          return 1;
        }

        // renew: pexpire
        ttlMs.set(key, Number(newTtl));

        return 1;
      },
    ),
  };

  /** Simulates the PX auto-expiry firing (a crashed holder's deadlock backstop). */
  const expireKey = (key: string) => {
    store.delete(key);
    ttlMs.delete(key);
  };

  return { redis, store, ttlMs, expireKey };
};

const buildStore = (
  overrides: Partial<{ ttlMs: number; renewMs: number }> = {},
) => {
  const { redis, store, ttlMs, expireKey } = buildRedisFake();
  const config = {
    userLockTtlMs: overrides.ttlMs ?? 30_000,
    userLockRenewMs: overrides.renewMs ?? 10_000,
  };
  const service = new UserLockStore(redis as never, config as never);

  return { service, redis, store, ttlMs, expireKey, config };
};

const USER = 'user-1';

describe('UserLockStore (per-user serialization lock, ADR 0039)', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('acquire writes the token under the per-user key with NX + PX TTL', async () => {
    const { service, redis, store, ttlMs } = buildStore();

    const token = await service.acquire(USER);

    expect(token).toBeTruthy();

    const [key, value, ...opts] = redis.set.mock.calls[0] as [
      string,
      string,
      ...unknown[],
    ];

    expect(key).toBe(userLockKey('user-1'));
    expect(value).toBe(token);
    expect(opts).toContain('NX');
    expect(opts).toContain('PX');
    expect(opts).toContain(30_000);
    expect(store.get(userLockKey('user-1'))).toBe(token);
    expect(ttlMs.get(userLockKey('user-1'))).toBe(30_000);
  });

  it('acquire-blocks-second-caller: a second acquire returns null while held', async () => {
    const { service } = buildStore();

    const first = await service.acquire(USER);
    const second = await service.acquire(USER);

    expect(first).toBeTruthy();
    expect(second).toBeNull();
  });

  it('a different user never contends — both acquire concurrently', async () => {
    const { service } = buildStore();

    const a = await service.acquire('user-a');
    const b = await service.acquire('user-b');

    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
  });

  it('release frees the lock so the next caller can acquire', async () => {
    const { service } = buildStore();

    const token = (await service.acquire(USER)) as string;

    expect(await service.acquire(USER)).toBeNull();

    expect(await service.release(USER, token)).toBe(true);
    expect(await service.acquire(USER)).toBeTruthy();
  });

  it('release-by-token-only: a non-holder token cannot release the lock', async () => {
    const { service, store } = buildStore();

    await service.acquire(USER);

    const released = await service.release(USER, 'someone-elses-token');

    expect(released).toBe(false);
    // The real holder's lock is untouched.
    expect(store.has(userLockKey('user-1'))).toBe(true);
  });

  it('auto-expiry: a crashed holder never deadlocks — the key lapses and a new caller acquires', async () => {
    const { service, expireKey } = buildStore();

    const stale = (await service.acquire(USER)) as string;

    // Holder "crashes" without releasing; PX TTL fires.
    expireKey(userLockKey('user-1'));

    // A fresh caller acquires the now-free lock.
    const fresh = await service.acquire(USER);

    expect(fresh).toBeTruthy();
    expect(fresh).not.toBe(stale);

    // And the crashed holder's stale token cannot release the new holder's lock.
    expect(await service.release(USER, stale)).toBe(false);
  });

  it('renew extends the TTL only while the caller still holds the lock', async () => {
    const { service, ttlMs, expireKey } = buildStore();

    const token = (await service.acquire(USER)) as string;

    expect(await service.renew(USER, token)).toBe(true);
    expect(ttlMs.get(userLockKey('user-1'))).toBe(30_000);

    // After expiry + a new holder, the old token's renew is rejected (no steal).
    expireKey(userLockKey('user-1'));
    await service.acquire(USER);

    expect(await service.renew(USER, token)).toBe(false);
  });

  it('watchdog-renew: runExclusive renews the TTL on the interval while work runs', async () => {
    jest.useFakeTimers();

    const { service, redis } = buildStore({ ttlMs: 30_000, renewMs: 10_000 });

    let resolveWork: (() => void) | undefined;
    const workDone = new Promise<void>((resolve) => {
      resolveWork = resolve;
    });

    const run = service.runExclusive(
      USER,
      async () => {
        await workDone;

        return 'ok';
      },
      () => 'busy',
    );

    // Advance two renew intervals while work is still in flight.
    await jest.advanceTimersByTimeAsync(10_000);
    await jest.advanceTimersByTimeAsync(10_000);

    // The watchdog fired renew (eval) at least twice.
    const renewCalls = redis.eval.mock.calls.filter(([script]) =>
      String(script).includes('pexpire'),
    );

    expect(renewCalls.length).toBeGreaterThanOrEqual(2);

    resolveWork?.();

    await expect(run).resolves.toBe('ok');
  });

  it('runExclusive releases the lock in finally even when work throws', async () => {
    const { service } = buildStore();

    await expect(
      service.runExclusive(
        USER,
        () => Promise.reject(new Error('boom')),
        () => 'busy',
      ),
    ).rejects.toThrow('boom');

    // Lock is free again — finally released it despite the throw.
    expect(await service.acquire(USER)).toBeTruthy();
  });

  it('runExclusive returns onBusy WITHOUT running work when the lock is held', async () => {
    const { service } = buildStore();

    // Hold the lock out-of-band.
    await service.acquire(USER);

    const work = jest.fn(() => Promise.resolve('ran'));
    const result = await service.runExclusive(USER, work, () => 'busy');

    expect(result).toBe('busy');
    expect(work).not.toHaveBeenCalled();
  });

  it('runExclusive clears the watchdog timer on completion (no timer leak)', async () => {
    jest.useFakeTimers();

    const clearSpy = jest.spyOn(global, 'clearInterval');

    const { service } = buildStore();

    await service.runExclusive(
      USER,
      () => Promise.resolve('ok'),
      () => 'busy',
    );

    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });
});
