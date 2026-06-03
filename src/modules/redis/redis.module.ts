import { Global, Module } from '@nestjs/common';
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
 * Global module providing a single ioredis {@link Redis} client built from the
 * validated env config. Made global so the assistant module and any future
 * Redis consumer (notification delivery) share one connection. The client is
 * disconnected on application shutdown via the `onModuleDestroy` hook below.
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
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule {}
