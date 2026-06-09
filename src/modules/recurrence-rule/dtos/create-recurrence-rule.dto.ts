import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayNotEmpty,
  IsArray,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';

import {
  RecurrenceEndType,
  RecurrenceFrequency,
} from '@/modules/database/entities';

/**
 * DTO for creating a RecurrenceRule (RFC-5545-lite). Date math is performed in
 * the owning task's timezone; this DTO only validates the rule grammar.
 *
 * Cross-field rules:
 * - `endType = COUNT` requires a positive `count`.
 * - `endType = UNTIL_DATE` requires an `endDate`.
 *
 * Weekday encoding for `byWeekday`: 0 = Monday … 6 = Sunday.
 */
export class CreateRecurrenceRuleDto {
  @ApiProperty({
    enum: RecurrenceFrequency,
    example: RecurrenceFrequency.WEEKLY,
  })
  @IsEnum(RecurrenceFrequency)
  frequency: RecurrenceFrequency;

  @ApiPropertyOptional({
    minimum: 1,
    default: 1,
    description: 'Repeat every N units of the frequency.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  interval?: number;

  /** Weekday ordinals (0 = Monday … 6 = Sunday). Absent means no weekday restriction. */
  @ApiPropertyOptional({
    type: [Number],
    example: [0, 2, 4],
    description: 'Weekday ordinals (0 = Monday … 6 = Sunday).',
  })
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  byWeekday?: number[];

  /** Days of the month (1-31). Absent means no month-day restriction. */
  @ApiPropertyOptional({
    type: [Number],
    example: [1, 15],
    description: 'Days of the month (1-31).',
  })
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(31, { each: true })
  byMonthDay?: number[];

  /** Months (1-12). Absent means no month restriction. */
  @ApiPropertyOptional({
    type: [Number],
    example: [1, 6, 12],
    description: 'Months (1-12).',
  })
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(12, { each: true })
  byMonth?: number[];

  @ApiPropertyOptional({
    enum: RecurrenceEndType,
    example: RecurrenceEndType.NEVER,
  })
  @IsOptional()
  @IsEnum(RecurrenceEndType)
  endType?: RecurrenceEndType;

  /** Required when `endType = UNTIL_DATE`. ISO 8601 date (or date-time). */
  @ApiPropertyOptional({
    format: 'date-time',
    description: 'Required when endType = UNTIL_DATE.',
    example: '2026-12-31T00:00:00.000Z',
  })
  @ValidateIf(
    (dto: CreateRecurrenceRuleDto) =>
      dto.endType === RecurrenceEndType.UNTIL_DATE,
  )
  @IsDateString()
  endDate?: string;

  /** Required and positive when `endType = COUNT`. */
  @ApiPropertyOptional({
    minimum: 1,
    description: 'Required and positive when endType = COUNT.',
    example: 10,
  })
  @ValidateIf(
    (dto: CreateRecurrenceRuleDto) => dto.endType === RecurrenceEndType.COUNT,
  )
  @IsInt()
  @Min(1)
  count?: number;
}
