import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
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
import { IsTaskColor } from '@/modules/task/dtos/is-task-color.validator';

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

  /** Default color: a preset name (e.g. BLUE) or a custom `#RRGGBB` hex. */
  @ApiPropertyOptional({ example: 'BLUE' })
  @IsOptional()
  @IsTaskColor()
  color?: string;

  @ApiPropertyOptional({ example: 'cart.fill', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  icon?: string;

  /** Group default completion requirement inherited by tasks (task-wins). */
  @ApiPropertyOptional({
    description: 'Default completion requirement inherited by tasks.',
  })
  @IsOptional()
  @IsBoolean()
  requiresCompletion?: boolean;

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
   * When present, stored inline as the group's default recurrenceConfig.
   * Tasks in this group with no own config will inherit this schedule.
   */
  @ApiPropertyOptional({
    type: () => CreateRecurrenceRuleDto,
    description: "Stored inline as the group's default recurrence.",
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => CreateRecurrenceRuleDto)
  recurrence?: CreateRecurrenceRuleDto;
}
