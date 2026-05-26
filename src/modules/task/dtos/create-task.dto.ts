import {
  IsBoolean,
  IsDateString,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * DTO for creating a new Task inside an existing Calendar.
 * Date fields arrive as ISO 8601 strings and are coerced to `Date` in the service layer.
 */
export class CreateTaskDto {
  @IsUUID()
  calendarId: string;

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  title: string;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsDateString()
  startAt?: string;

  @IsOptional()
  @IsDateString()
  endAt?: string;

  @IsOptional()
  @IsBoolean()
  isAllDay?: boolean;

  @IsString()
  @MinLength(1)
  timezone: string;

  @IsOptional()
  @IsBoolean()
  requiresCompletion?: boolean;
}
