import { ApiProperty } from '@nestjs/swagger';

/**
 * Reusable response shape for endpoints that return only the affected row id —
 * e.g. soft-delete handlers that respond `200 { id }` so the iOS client can decode.
 */
export class IdResponseDto {
  @ApiProperty({
    format: 'uuid',
    example: '3f1c2b7e-9a4d-4f3a-bb2e-1d5c6e7f8a90',
  })
  id: string;
}
