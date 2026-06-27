import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayNotEmpty,
  IsArray,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';

import { MonthlyAnchorMode } from '../recurrence.types';
import {
  RecurrenceEndType,
  RecurrenceFrequency,
} from '@/modules/database/entities';

/**
 * DTO for partially updating a RecurrenceRule. Every field is optional; only the
 * provided fields are mutated on the loaded entity.
 *
 * Cross-field rules apply only when `endType` is included in the payload:
 * setting `endType = COUNT` requires `count`; `endType = UNTIL_DATE` requires `endDate`.
 */
export class UpdateRecurrenceRuleDto {
  @ApiPropertyOptional({ enum: RecurrenceFrequency })
  @IsOptional()
  @IsEnum(RecurrenceFrequency)
  frequency?: RecurrenceFrequency;

  @ApiPropertyOptional({ minimum: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  interval?: number;

  /** Weekday ordinals (0 = Monday … 6 = Sunday). */
  @ApiPropertyOptional({
    type: [Number],
    description: 'Weekday ordinals (0 = Monday … 6 = Sunday).',
  })
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  byWeekday?: number[];

  /** Days of the month (1-31). */
  @ApiPropertyOptional({
    type: [Number],
    description: 'Days of the month (1-31).',
  })
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(31, { each: true })
  byMonthDay?: number[];

  /** Months (1-12). */
  @ApiPropertyOptional({ type: [Number], description: 'Months (1-12).' })
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(12, { each: true })
  byMonth?: number[];

  /** MONTHLY nth-weekday ordinals (1..4 = first..fourth, -1 = last); combine with byWeekday. */
  @ApiPropertyOptional({
    type: [Number],
    description:
      'MONTHLY nth-weekday ordinals (1..4 = first..fourth, -1 = last); combine with byWeekday.',
  })
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsInt({ each: true })
  @IsIn([-1, 1, 2, 3, 4], { each: true })
  bySetPos?: number[];

  /** MONTHLY working-day anchor (first/last/day-before-last Mon–Fri of the month). */
  @ApiPropertyOptional({ enum: MonthlyAnchorMode })
  @IsOptional()
  @IsEnum(MonthlyAnchorMode)
  monthlyAnchor?: MonthlyAnchorMode;

  @ApiPropertyOptional({ enum: RecurrenceEndType })
  @IsOptional()
  @IsEnum(RecurrenceEndType)
  endType?: RecurrenceEndType;

  /** Required when this payload sets `endType = UNTIL_DATE`. */
  @ApiPropertyOptional({
    format: 'date-time',
    description: 'Required when this payload sets endType = UNTIL_DATE.',
  })
  @ValidateIf(
    (dto: UpdateRecurrenceRuleDto) =>
      dto.endType === RecurrenceEndType.UNTIL_DATE,
  )
  @IsDateString()
  endDate?: string;

  /** Required and positive when this payload sets `endType = COUNT`. */
  @ApiPropertyOptional({
    minimum: 1,
    description:
      'Required and positive when this payload sets endType = COUNT.',
  })
  @ValidateIf(
    (dto: UpdateRecurrenceRuleDto) => dto.endType === RecurrenceEndType.COUNT,
  )
  @IsInt()
  @Min(1)
  count?: number;
}
