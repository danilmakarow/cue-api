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
  ValidateNested,
} from 'class-validator';

import { IsTaskColor } from './is-task-color.validator';
import { ReminderDto } from './reminder.dto';
import { CreateRecurrenceRuleDto } from '@/modules/recurrence-rule/dtos';

/**
 * DTO for creating a new Task inside an existing Calendar.
 * Date fields arrive as ISO 8601 strings and are coerced to `Date` in the service layer.
 *
 * A task may be a timed event, an all-day event, or a todo (no `startAt`/`endAt`).
 * When `recurrence` is present the service stores it inline on the single anchor
 * row as `recurrenceConfig` — never N materialized rows (ADR 0054). `groupId`,
 * when set, must reference a `TaskGroup` in the same calendar.
 */
export class CreateTaskDto {
  @ApiProperty({ format: 'uuid', description: 'Calendar that owns this task.' })
  @IsUUID()
  calendarId: string;

  @ApiProperty({ example: 'Buy groceries', maxLength: 255 })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  title: string;

  @ApiPropertyOptional({ example: 'Milk, eggs, bread' })
  @IsOptional()
  @IsString()
  notes?: string;

  @ApiPropertyOptional({
    format: 'date-time',
    description: 'ISO 8601 start; omit for a timeless todo.',
    example: '2026-06-09T09:00:00.000Z',
  })
  @IsOptional()
  @IsDateString()
  startAt?: string;

  @ApiPropertyOptional({
    format: 'date-time',
    example: '2026-06-09T10:00:00.000Z',
  })
  @IsOptional()
  @IsDateString()
  endAt?: string;

  @ApiPropertyOptional({ description: 'Marks the task as an all-day event.' })
  @IsOptional()
  @IsBoolean()
  isAllDay?: boolean;

  @ApiProperty({
    description: 'IANA timezone the task time-of-day is anchored to.',
    example: 'Europe/Berlin',
  })
  @IsString()
  @MinLength(1)
  timezone: string;

  @ApiPropertyOptional({
    description: 'Whether the task must be explicitly completed.',
  })
  @IsOptional()
  @IsBoolean()
  requiresCompletion?: boolean;

  /** Optional color: a preset name (e.g. BLUE) or a custom `#RRGGBB` hex. */
  @ApiPropertyOptional({
    example: 'BLUE',
    description: 'Color preset name or a custom #RRGGBB hex.',
  })
  @IsOptional()
  @IsTaskColor()
  color?: string;

  /** Optional per-task icon (an SF Symbol name); null/omitted leaves it iconless. */
  @ApiPropertyOptional({
    example: 'cart.fill',
    maxLength: 255,
    description: 'Per-task icon name (e.g. an SF Symbol).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  icon?: string;

  /** Optional per-task reminders persisted as taskId-linked notification rules. */
  @ApiPropertyOptional({
    type: () => [ReminderDto],
    description: 'Per-task reminders (offset + channel).',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => ReminderDto)
  reminders?: ReminderDto[];

  /** Optional group this task belongs to; must live in the same calendar. */
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Group this task belongs to; must live in the same calendar.',
  })
  @IsOptional()
  @IsUUID()
  groupId?: string;

  /** When present, makes the task recurring via a single inline recurrenceConfig. */
  @ApiPropertyOptional({
    type: () => CreateRecurrenceRuleDto,
    description: 'When present, makes the task recurring.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => CreateRecurrenceRuleDto)
  recurrence?: CreateRecurrenceRuleDto;
}
