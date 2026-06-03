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
 * DTO for updating an existing Task (the "all" / one-off scope). Every field is
 * optional — omitted keys leave the current value unchanged. `recurrence: null`
 * removes the recurrence rule entirely.
 */
export class UpdateTaskDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  title?: string;

  @IsOptional()
  @IsString()
  notes?: string | null;

  @IsOptional()
  @IsDateString()
  startAt?: string | null;

  @IsOptional()
  @IsDateString()
  endAt?: string | null;

  @IsOptional()
  @IsBoolean()
  isAllDay?: boolean;

  @IsOptional()
  @IsBoolean()
  requiresCompletion?: boolean;

  /** Set to a UUID to assign to a group; null to ungroup. */
  @IsOptional()
  @IsUUID()
  groupId?: string | null;

  /**
   * When set to a rule DTO, adds or replaces the master rule.
   * When set to `null`, removes recurrence entirely.
   */
  @IsOptional()
  @ValidateNested()
  @Type(() => CreateRecurrenceRuleDto)
  recurrence?: CreateRecurrenceRuleDto | null;
}
