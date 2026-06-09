import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * DTO for `POST /auth/apple`. `identityToken` is the JWT returned by
 * `ASAuthorizationAppleIDCredential.identityToken` on the iOS client.
 * `fullName` and `avatarBase64` are only supplied on first sign-in
 * (Apple surfaces the name once) and are optional thereafter.
 */
export class AppleSignInDto {
  @ApiProperty({
    description: 'Apple identity token (JWT) from Sign in with Apple.',
    example: 'eyJraWQiOiJ...Qssw5c',
  })
  @IsString()
  @MinLength(1)
  identityToken: string;

  @ApiPropertyOptional({
    description: 'Display name; only sent by Apple on first sign-in.',
    example: 'Jane Appleseed',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  fullName?: string;

  /**
   * Base64-encoded profile picture (no data-URL prefix). Capped well above the
   * ~1 MB JPEG payload the iOS client produces.
   */
  @ApiPropertyOptional({
    description: 'Base64-encoded profile picture (no data-URL prefix).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(5_000_000)
  avatarBase64?: string;

  @ApiPropertyOptional({
    description: 'IANA timezone identifier for the new account.',
    example: 'Europe/Berlin',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;
}
