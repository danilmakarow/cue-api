import { ApiPropertyOptional } from '@nestjs/swagger';
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
  @ApiPropertyOptional({ example: 'Buy groceries', maxLength: 255 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  title?: string;

  @ApiPropertyOptional({ nullable: true, example: 'Milk, eggs, bread' })
  @IsOptional()
  @IsString()
  notes?: string | null;

  @ApiPropertyOptional({
    format: 'date-time',
    nullable: true,
    example: '2026-06-09T09:00:00.000Z',
  })
  @IsOptional()
  @IsDateString()
  startAt?: string | null;

  @ApiPropertyOptional({
    format: 'date-time',
    nullable: true,
    example: '2026-06-09T10:00:00.000Z',
  })
  @IsOptional()
  @IsDateString()
  endAt?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isAllDay?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  requiresCompletion?: boolean;

  /** Set to a UUID to assign to a group; null to ungroup. */
  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    description: 'UUID to assign to a group; null to ungroup.',
  })
  @IsOptional()
  @IsUUID()
  groupId?: string | null;

  /**
   * When set to a rule DTO, adds or replaces the master rule.
   * When set to `null`, removes recurrence entirely.
   */
  @ApiPropertyOptional({
    type: () => CreateRecurrenceRuleDto,
    nullable: true,
    description: 'Rule DTO adds/replaces the master rule; null removes it.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => CreateRecurrenceRuleDto)
  recurrence?: CreateRecurrenceRuleDto | null;
}
