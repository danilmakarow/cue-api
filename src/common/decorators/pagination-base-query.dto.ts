import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsNumber, IsOptional, IsPositive } from 'class-validator';

/**
 * Upper bound for the page size, mirrored in the `limit` field description.
 * Kept local so this query DTO stays decoupled from the database repositories.
 */
const PAGE_SIZE_MAX = 100;

/**
 * Shared query parameters for paginated list endpoints (`limit`, `page`). Extend
 * this DTO per endpoint to add filtering/sorting params.
 */
export class PaginationBaseQueryDto {
  @ApiPropertyOptional({
    example: 20,
    description: `Items per page, from 1 to ${PAGE_SIZE_MAX}.`,
  })
  @IsOptional()
  @IsNumber()
  @IsPositive()
  @Type(() => Number)
  limit?: number;

  @ApiPropertyOptional({ example: 1, description: 'One-based page number.' })
  @IsOptional()
  @IsNumber()
  @IsPositive()
  @Type(() => Number)
  page?: number;
}
