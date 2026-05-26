import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * DTO for creating a new Calendar for the authenticated user.
 * Validated by the global ValidationPipe with `whitelist: true`.
 */
export class CreateCalendarDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  color?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  icon?: string;
}
