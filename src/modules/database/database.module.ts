import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import {
  Calendar,
  Device,
  NotificationRule,
  NotificationStrategy,
  RecurrenceRule,
  ScheduledNotification,
  Task,
  TaskGroup,
  TaskOccurrenceException,
  TelegramLink,
  User,
} from './entities';
import {
  CalendarRepository,
  DeviceRepository,
  NotificationRuleRepository,
  NotificationStrategyRepository,
  RecurrenceRuleRepository,
  ScheduledNotificationRepository,
  TaskGroupRepository,
  TaskOccurrenceExceptionRepository,
  TaskRepository,
  TelegramLinkRepository,
  UserRepository,
} from './repositories';
import {
  CalendarDatabaseService,
  DeviceDatabaseService,
  NotificationRuleDatabaseService,
  NotificationStrategyDatabaseService,
  RecurrenceRuleDatabaseService,
  ScheduledNotificationDatabaseService,
  TaskDatabaseService,
  TaskGroupDatabaseService,
  TaskOccurrenceExceptionDatabaseService,
  TelegramLinkDatabaseService,
  UserDatabaseService,
} from './services';

/**
 * Database module that registers every Cue entity with TypeORM and wires the repository
 * and database-service pairs that feature modules consume. Direct use of repositories
 * or entities outside this module is intentionally discouraged — all access flows through
 * the exported database services.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      User,
      Device,
      TelegramLink,
      Calendar,
      TaskGroup,
      Task,
      RecurrenceRule,
      TaskOccurrenceException,
      NotificationStrategy,
      NotificationRule,
      ScheduledNotification,
    ]),
  ],
  providers: [
    UserRepository,
    DeviceRepository,
    TelegramLinkRepository,
    CalendarRepository,
    TaskGroupRepository,
    TaskRepository,
    RecurrenceRuleRepository,
    TaskOccurrenceExceptionRepository,
    NotificationStrategyRepository,
    NotificationRuleRepository,
    ScheduledNotificationRepository,
    UserDatabaseService,
    DeviceDatabaseService,
    TelegramLinkDatabaseService,
    CalendarDatabaseService,
    TaskGroupDatabaseService,
    TaskDatabaseService,
    RecurrenceRuleDatabaseService,
    TaskOccurrenceExceptionDatabaseService,
    NotificationStrategyDatabaseService,
    NotificationRuleDatabaseService,
    ScheduledNotificationDatabaseService,
  ],
  exports: [
    UserDatabaseService,
    DeviceDatabaseService,
    TelegramLinkDatabaseService,
    CalendarDatabaseService,
    TaskGroupDatabaseService,
    TaskDatabaseService,
    RecurrenceRuleDatabaseService,
    TaskOccurrenceExceptionDatabaseService,
    NotificationStrategyDatabaseService,
    NotificationRuleDatabaseService,
    ScheduledNotificationDatabaseService,
  ],
})
export class DatabaseModule {}
