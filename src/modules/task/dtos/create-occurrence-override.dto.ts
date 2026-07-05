import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

import { IsTaskColor } from './is-task-color.validator';
import { ReminderDto } from './reminder.dto';

/**
 * DTO for `POST /tasks/:id/occurrences/override`. `originalStart` is REQUIRED and
 * identifies which generated occurrence of the parent series to materialize. The
 * remaining fields are the optional patch applied on top of the parent snapshot
 * (tri-state: omitted inherits the snapshot, null clears where nullable). There
 * is deliberately no `recurrence` field — an override child never recurs.
 */
export class CreateOccurrenceOverrideDto {
  @ApiProperty({
    format: 'date-time',
    description: 'The pre-override generated instant this override replaces.',
    example: '2026-07-10T09:00:00.000Z',
  })
  @IsDateString()
  originalStart: string;

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
    example: '2026-07-10T11:00:00.000Z',
  })
  @IsOptional()
  @IsDateString()
  startAt?: string | null;

  @ApiPropertyOptional({
    format: 'date-time',
    nullable: true,
    example: '2026-07-10T12:00:00.000Z',
  })
  @IsOptional()
  @IsDateString()
  endAt?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isAllDay?: boolean;

  /**
   * IANA timezone the bare wall-clock `startAt`/`endAt` are interpreted in (and
   * the child's stored timezone). Omit to keep the parent's timezone.
   */
  @ApiPropertyOptional({ example: 'Europe/Berlin' })
  @IsOptional()
  @IsString()
  timezone?: string;

  /** Boolean to set the child's own value; null to clear it (then inherit). */
  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsBoolean()
  requiresCompletion?: boolean | null;

  /** Preset name / `#RRGGBB` hex to set; null to clear (then inherit). */
  @ApiPropertyOptional({ nullable: true, example: 'BLUE' })
  @IsOptional()
  @ValidateIf((dto: CreateOccurrenceOverrideDto) => dto.color !== null)
  @IsTaskColor()
  color?: string | null;

  /** Per-task icon name to set; null to clear it. */
  @ApiPropertyOptional({ nullable: true, example: 'cart.fill', maxLength: 255 })
  @IsOptional()
  @ValidateIf((dto: CreateOccurrenceOverrideDto) => dto.icon !== null)
  @IsString()
  @MaxLength(255)
  icon?: string | null;

  /** Set to a UUID to assign to a group; null to ungroup. */
  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  @IsOptional()
  @IsUUID()
  groupId?: string | null;

  /**
   * When provided, REPLACES the full set of the child's per-task reminders (an
   * empty array clears them). Omitted keeps the reminders copied from the parent.
   */
  @ApiPropertyOptional({
    type: () => [ReminderDto],
    description: "Replaces the full set of the override's per-task reminders.",
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => ReminderDto)
  reminders?: ReminderDto[];
}
