import { ApiProperty } from '@nestjs/swagger';

/**
 * Reusable response shape for endpoints that acknowledge success with a bare
 * `{ ok: true }` body rather than the affected resource.
 */
export class OkResponseDto {
  @ApiProperty({ example: true })
  ok: boolean;
}
