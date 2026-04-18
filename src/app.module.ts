import { Module, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_PIPE } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AppController } from './app.controller';
import { DatabaseModule } from './modules/database/database.module';
import { DeviceModule } from './modules/device/device.module';
import { NotificationRuleModule } from './modules/notification-rule/notification-rule.module';
import { NotificationStrategyModule } from './modules/notification-strategy/notification-strategy.module';
import { RecurrenceRuleModule } from './modules/recurrence-rule/recurrence-rule.module';
import { ScheduledNotificationModule } from './modules/scheduled-notification/scheduled-notification.module';
import { TaskModule } from './modules/task/task.module';
import { TaskGroupModule } from './modules/task-group/task-group.module';
import { TaskOccurrenceExceptionModule } from './modules/task-occurrence-exception/task-occurrence-exception.module';
import { TelegramLinkModule } from './modules/telegram-link/telegram-link.module';
import { UserModule } from './modules/user/user.module';
import { getConfigModule } from '@/config/env.config';
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
    DatabaseModule,
    UserModule,
    DeviceModule,
    TelegramLinkModule,
    TaskGroupModule,
    TaskModule,
    RecurrenceRuleModule,
    TaskOccurrenceExceptionModule,
    NotificationStrategyModule,
    NotificationRuleModule,
    ScheduledNotificationModule,
  ],
  controllers: [AppController],
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
