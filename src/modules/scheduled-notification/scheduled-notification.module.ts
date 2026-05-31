import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';

import { ScheduledNotificationService } from './scheduled-notification.service';

/**
 * ScheduledNotification module owning the delivery-queue outbox and worker entry points.
 */
@Module({
  imports: [DatabaseModule],
  providers: [ScheduledNotificationService],
  exports: [ScheduledNotificationService],
})
export class ScheduledNotificationModule {}
