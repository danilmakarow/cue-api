import { Redis } from 'ioredis';

import { RedisLifecycle } from './redis.module';

/**
 * Builds a minimal `Redis` test double exposing only the surface
 * {@link RedisLifecycle} touches (`status` + `quit`), cast to `Redis` so the
 * constructor's typed injection is satisfied without a live connection.
 */
const createRedisDouble = (status: Redis['status'], quit: jest.Mock): Redis =>
  ({ status, quit }) as unknown as Redis;

describe('RedisLifecycle', () => {
  it('quits the client on module destroy when it is ready', async () => {
    const quit = jest.fn().mockResolvedValue('OK');
    const lifecycle = new RedisLifecycle(createRedisDouble('ready', quit));

    await lifecycle.onModuleDestroy();

    expect(quit).toHaveBeenCalledTimes(1);
  });

  it('skips quit when the client is already ended', async () => {
    const quit = jest.fn();
    const lifecycle = new RedisLifecycle(createRedisDouble('end', quit));

    await lifecycle.onModuleDestroy();

    expect(quit).not.toHaveBeenCalled();
  });

  it('skips quit when the client is already closing', async () => {
    const quit = jest.fn();
    const lifecycle = new RedisLifecycle(createRedisDouble('close', quit));

    await lifecycle.onModuleDestroy();

    expect(quit).not.toHaveBeenCalled();
  });

  it('swallows a quit rejection so teardown never throws', async () => {
    const quit = jest
      .fn()
      .mockRejectedValue(new Error('Connection is closed.'));
    const lifecycle = new RedisLifecycle(createRedisDouble('ready', quit));

    await expect(lifecycle.onModuleDestroy()).resolves.toBeUndefined();
    expect(quit).toHaveBeenCalledTimes(1);
  });
});
