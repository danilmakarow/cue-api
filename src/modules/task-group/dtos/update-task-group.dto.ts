import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

import { CreateRecurrenceRuleDto } from '@/modules/recurrence-rule/dtos';

/**
 * DTO for updating a TaskGroup. All fields are optional — omitted keys leave the
 * current value unchanged. `recurrence: null` removes the default recurrence rule.
 */
export class UpdateTaskGroupDto {
  @ApiPropertyOptional({ example: 'Errands', maxLength: 255 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name?: string;

  @ApiPropertyOptional({ nullable: true, example: '#E27921', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  color?: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'cart.fill', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  icon?: string | null;

  @ApiPropertyOptional({ minimum: 0, description: 'Ascending display order.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  /**
   * When set to a rule DTO, adds or replaces the group's default recurrence rule.
   * When set to `null`, removes the default recurrence rule. When omitted, the
   * current rule is left unchanged.
   */
  @ApiPropertyOptional({
    type: () => CreateRecurrenceRuleDto,
    nullable: true,
    description:
      "Rule DTO adds/replaces the group's default rule; null removes it.",
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => CreateRecurrenceRuleDto)
  recurrence?: CreateRecurrenceRuleDto | null;
}
