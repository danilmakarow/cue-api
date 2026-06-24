import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

import { CreateRecurrenceRuleDto } from '@/modules/recurrence-rule/dtos';
import { IsTaskColor } from '@/modules/task/dtos/is-task-color.validator';

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

  /** Preset name / `#RRGGBB` hex to set; null to clear the default. */
  @ApiPropertyOptional({ nullable: true, example: 'BLUE' })
  @IsOptional()
  @ValidateIf((dto: UpdateTaskGroupDto) => dto.color !== null)
  @IsTaskColor()
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

  /** Boolean to set the group default; null to clear it. */
  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsBoolean()
  requiresCompletion?: boolean | null;

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
