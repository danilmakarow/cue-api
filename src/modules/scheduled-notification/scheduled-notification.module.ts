import { Module } from '@nestjs/common';

import { ScheduledNotificationService } from './scheduled-notification.service';
import { DatabaseModule } from '../database/database.module';

/**
 * ScheduledNotification module owning the delivery-queue outbox and worker entry points.
 */
@Module({
  imports: [DatabaseModule],
  providers: [ScheduledNotificationService],
  exports: [ScheduledNotificationService],
})
export class ScheduledNotificationModule {}
