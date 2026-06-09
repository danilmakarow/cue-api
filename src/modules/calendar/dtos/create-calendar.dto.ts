import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * DTO for creating a new Calendar for the authenticated user.
 * Validated by the global ValidationPipe with `whitelist: true`.
 */
export class CreateCalendarDto {
  @ApiProperty({ example: 'Work', maxLength: 100 })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name: string;

  @ApiPropertyOptional({
    description: 'Hex color or named token for the calendar.',
    example: '#E27921',
    maxLength: 30,
  })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  color?: string;

  @ApiPropertyOptional({
    description: 'SF Symbol name or icon token.',
    example: 'briefcase.fill',
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  icon?: string;
}
