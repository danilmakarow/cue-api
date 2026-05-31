import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';

import { CalendarController } from './calendar.controller';
import { CalendarService } from './calendar.service';

/**
 * Calendar module managing the organizational units that own tasks, task groups,
 * and notification strategies.
 */
@Module({
  imports: [DatabaseModule],
  controllers: [CalendarController],
  providers: [CalendarService],
  exports: [CalendarService],
})
export class CalendarModule {}
