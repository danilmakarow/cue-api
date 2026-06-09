import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
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
  @ApiProperty({
    format: 'uuid',
    description: 'Calendar that owns this group.',
  })
  @IsUUID()
  calendarId: string;

  @ApiProperty({ example: 'Errands', maxLength: 255 })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name: string;

  @ApiPropertyOptional({ example: '#E27921', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  color?: string;

  @ApiPropertyOptional({ example: 'cart.fill', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  icon?: string;

  /** Optional default notification strategy inherited by tasks in this group. */
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Default notification strategy inherited by tasks in this group.',
  })
  @IsOptional()
  @IsUUID()
  defaultNotificationStrategyId?: string;

  /** Ascending display order within the calendar; defaults to 0 when omitted. */
  @ApiPropertyOptional({
    minimum: 0,
    default: 0,
    description: 'Ascending display order within the calendar.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  /**
   * When present, creates a RecurrenceRule and sets it as the group's default.
   * Tasks in this group with no own rule will inherit this schedule.
   */
  @ApiPropertyOptional({
    type: () => CreateRecurrenceRuleDto,
    description: "Creates a RecurrenceRule and sets it as the group's default.",
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => CreateRecurrenceRuleDto)
  recurrence?: CreateRecurrenceRuleDto;
}
