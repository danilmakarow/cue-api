import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

import { CreateRecurrenceRuleDto } from '@/modules/recurrence-rule/dtos';

/**
 * DTO for creating a new Task inside an existing Calendar.
 * Date fields arrive as ISO 8601 strings and are coerced to `Date` in the service layer.
 *
 * A task may be a timed event, an all-day event, or a todo (no `startAt`/`endAt`).
 * When `recurrence` is present the service creates one `RecurrenceRule` and links
 * the single anchor row to it — never N materialized rows. `groupId`, when set,
 * must reference a `TaskGroup` in the same calendar.
 */
export class CreateTaskDto {
  @IsUUID()
  calendarId: string;

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  title: string;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsDateString()
  startAt?: string;

  @IsOptional()
  @IsDateString()
  endAt?: string;

  @IsOptional()
  @IsBoolean()
  isAllDay?: boolean;

  @IsString()
  @MinLength(1)
  timezone: string;

  @IsOptional()
  @IsBoolean()
  requiresCompletion?: boolean;

  /** Optional group this task belongs to; must live in the same calendar. */
  @IsOptional()
  @IsUUID()
  groupId?: string;

  /** When present, makes the task recurring via a single linked RecurrenceRule. */
  @IsOptional()
  @ValidateNested()
  @Type(() => CreateRecurrenceRuleDto)
  recurrence?: CreateRecurrenceRuleDto;
}
