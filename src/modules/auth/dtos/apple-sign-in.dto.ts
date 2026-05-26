import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * DTO for `POST /auth/apple`. `identityToken` is the JWT returned by
 * `ASAuthorizationAppleIDCredential.identityToken` on the iOS client.
 * `fullName` and `avatarBase64` are only supplied on first sign-in
 * (Apple surfaces the name once) and are optional thereafter.
 */
export class AppleSignInDto {
  @IsString()
  @MinLength(1)
  identityToken: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  fullName?: string;

  /**
   * Base64-encoded profile picture (no data-URL prefix). Capped well above the
   * ~1 MB JPEG payload the iOS client produces.
   */
  @IsOptional()
  @IsString()
  @MaxLength(5_000_000)
  avatarBase64?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;
}
