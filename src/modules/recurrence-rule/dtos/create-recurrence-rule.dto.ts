import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
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

import { IsValidMonthlySelectors } from './is-valid-monthly-selectors.validator';
import { MonthlyAnchorMode } from '../recurrence.types';
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
 * - `bySetPos` requires a non-empty `byWeekday` and MONTHLY frequency.
 * - `monthlyAnchor` is mutually exclusive with `byMonthDay` / `bySetPos` /
 *   `byWeekday` and is MONTHLY-only.
 *
 * Weekday encoding for `byWeekday`: 0 = Monday … 6 = Sunday.
 */
export class CreateRecurrenceRuleDto {
  @ApiProperty({
    enum: RecurrenceFrequency,
    example: RecurrenceFrequency.WEEKLY,
  })
  @IsEnum(RecurrenceFrequency)
  @IsValidMonthlySelectors()
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

  /**
   * MONTHLY nth-weekday ordinals (RFC-5545 BYSETPOS): 1..4 = first..fourth,
   * -1 = last. Combined with `byWeekday` to express "first Monday" / "last
   * Friday". Absent means no ordinal restriction.
   */
  @ApiPropertyOptional({
    type: [Number],
    example: [1],
    description:
      'MONTHLY nth-weekday ordinals (1..4 = first..fourth, -1 = last); combine with byWeekday.',
  })
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsInt({ each: true })
  @IsIn([-1, 1, 2, 3, 4], { each: true })
  bySetPos?: number[];

  /**
   * MONTHLY working-day (Mon–Fri) anchor: first / last / day-before-last working
   * day of the month. Mutually exclusive with `byMonthDay` / `bySetPos`. Absent
   * means no working-day anchor.
   */
  @ApiPropertyOptional({
    enum: MonthlyAnchorMode,
    example: MonthlyAnchorMode.LAST_WORKDAY,
    description:
      'MONTHLY working-day anchor (first/last/day-before-last Mon–Fri).',
  })
  @IsOptional()
  @IsEnum(MonthlyAnchorMode)
  monthlyAnchor?: MonthlyAnchorMode;

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
