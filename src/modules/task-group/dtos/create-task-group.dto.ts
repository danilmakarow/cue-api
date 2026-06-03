import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

import { CreateRecurrenceRuleDto } from '@/modules/recurrence-rule/dtos';

/**
 * DTO for creating a new TaskGroup inside an existing Calendar. The referenced
 * calendar must belong to the current user; ownership is asserted in the service.
 */
export class CreateTaskGroupDto {
  @IsUUID()
  calendarId: string;

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  color?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  icon?: string;

  /** Optional default notification strategy inherited by tasks in this group. */
  @IsOptional()
  @IsUUID()
  defaultNotificationStrategyId?: string;

  /** Ascending display order within the calendar; defaults to 0 when omitted. */
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  /**
   * When present, creates a RecurrenceRule and sets it as the group's default.
   * Tasks in this group with no own rule will inherit this schedule.
   */
  @IsOptional()
  @ValidateNested()
  @Type(() => CreateRecurrenceRuleDto)
  recurrence?: CreateRecurrenceRuleDto;
}
