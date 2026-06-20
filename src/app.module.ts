import { BullModule } from '@nestjs/bullmq';
import { Module, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_PIPE } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AppController } from './app.controller';
import { AssistantModule } from './modules/assistant/assistant.module';
import { AuthModule } from './modules/auth/auth.module';
import { CalendarModule } from './modules/calendar/calendar.module';
import { DatabaseModule } from './modules/database/database.module';
import { DeviceModule } from './modules/device/device.module';
import { NotificationRuleModule } from './modules/notification-rule/notification-rule.module';
import { NotificationStrategyModule } from './modules/notification-strategy/notification-strategy.module';
import { RecurrenceRuleModule } from './modules/recurrence-rule/recurrence-rule.module';
import { RedisModule } from './modules/redis/redis.module';
import { ScheduledNotificationModule } from './modules/scheduled-notification/scheduled-notification.module';
import { TaskModule } from './modules/task/task.module';
import { TaskGroupModule } from './modules/task-group/task-group.module';
import { TaskOccurrenceExceptionModule } from './modules/task-occurrence-exception/task-occurrence-exception.module';
import { TelegramLinkModule } from './modules/telegram-link/telegram-link.module';
import { UserModule } from './modules/user/user.module';
import { WellKnownController } from './modules/well-known/well-known.controller';
import { EnvironmentVariables, getConfigModule } from '@/config/env.config';
import { getDatabaseConfig, getDataSource } from '@/config/typeorm.config';

/**
 * Root application module wiring configuration, database access, scheduled jobs, and feature modules.
 */
@Module({
  imports: [
    ScheduleModule.forRoot(),
    getConfigModule(),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: getDatabaseConfig,
      dataSourceFactory: getDataSource,
    }),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (
        configService: ConfigService<EnvironmentVariables, true>,
      ) => ({
        connection: {
          host: configService.get('REDIS_HOST', { infer: true }),
          port: configService.get('REDIS_PORT', { infer: true }),
          password: configService.get('REDIS_PASSWORD', { infer: true }),
          db: configService.get('REDIS_DB', { infer: true }),
        },
        defaultJobOptions: {
          // GLOBAL default for all queues. The inbound webhook queue overrides
          // attempts to 1 at its own registerQueue + per-job (ADR-0026); this
          // default stays at 5+backoff for every other/future queue.
          attempts: 5,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: true,
          removeOnFail: false,
        },
      }),
    }),
    RedisModule,
    DatabaseModule,
    AuthModule,
    UserModule,
    DeviceModule,
    TelegramLinkModule,
    CalendarModule,
    TaskGroupModule,
    TaskModule,
    RecurrenceRuleModule,
    TaskOccurrenceExceptionModule,
    NotificationStrategyModule,
    NotificationRuleModule,
    ScheduledNotificationModule,
    AssistantModule,
  ],
  controllers: [AppController, WellKnownController],
  providers: [
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    },
  ],
})
export class AppModule {}
