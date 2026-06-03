import { Module } from '@nestjs/common';

import { CalendarController } from './calendar.controller';
import { CalendarService } from './calendar.service';
import { DatabaseModule } from '../database/database.module';

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
