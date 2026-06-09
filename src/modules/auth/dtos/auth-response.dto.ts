import { ApiProperty } from '@nestjs/swagger';

import { User } from '@/modules/database/entities';

/**
 * Response returned by `POST /auth/apple` (and the dev login) — the issued Cue
 * JWT plus the resolved user. Used for Swagger documentation; handlers return a
 * structurally compatible object, so no instantiation is needed.
 */
export class AuthResponseDto {
  @ApiProperty({ description: 'Cue JWT to send as `Authorization: Bearer`.' })
  accessToken: string;

  @ApiProperty({ type: () => User })
  user: User;
}
