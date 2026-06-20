import {
  Global,
  Inject,
  Injectable,
  Module,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';

import { EnvironmentVariables } from '@/config/env.config';

/**
 * Injection token for the shared ioredis client. Inject this to use Redis
 * directly (dedupe set, link nonces, held-conflict writes); the BullMQ webhook
 * queue is configured separately from the same connection settings.
 */
export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

/**
 * Lifecycle owner for the shared {@link Redis} client. The `REDIS_CLIENT`
 * provider is a `useFactory` *value* (a bare `new Redis(...)`), so it cannot
 * implement a Nest lifecycle hook itself — Nest only calls `onModuleDestroy` on
 * provider *instances of a class*. This thin `@Injectable` closes that gap: it
 * injects the same client and quits it on `onModuleDestroy` (fired on
 * `app.close()`), so the ioredis socket no longer leaks as an open handle on
 * shutdown / e2e teardown.
 */
@Injectable()
export class RedisLifecycle implements OnModuleDestroy {
  public constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /**
   * Quits the shared ioredis client on module teardown. Guards against quitting
   * a client that is already closing/closed (`quit()` would reject with
   * `Connection is closed.`), and swallows any quit error so teardown never
   * throws.
   */
  public async onModuleDestroy(): Promise<void> {
    if (this.redis.status === 'end' || this.redis.status === 'close') {
      return;
    }

    try {
      await this.redis.quit();
    } catch {
      // client already disconnected / closing — nothing to do
    }
  }
}

/**
 * Global module providing a single ioredis {@link Redis} client built from the
 * validated env config. Made global so the assistant module and any future
 * Redis consumer (notification delivery) share one connection. The client is
 * closed on application shutdown by {@link RedisLifecycle}, whose
 * `onModuleDestroy` hook quits the shared client (the value provider itself
 * cannot carry a lifecycle hook).
 */
@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (
        configService: ConfigService<EnvironmentVariables, true>,
      ): Redis =>
        new Redis({
          host: configService.get('REDIS_HOST', { infer: true }),
          port: configService.get('REDIS_PORT', { infer: true }),
          password: configService.get('REDIS_PASSWORD', { infer: true }),
          db: configService.get('REDIS_DB', { infer: true }),
          // BullMQ requires this to be null; harmless for the shared client too.
          maxRetriesPerRequest: null,
        }),
    },
    RedisLifecycle,
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule {}
