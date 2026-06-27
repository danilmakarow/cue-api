import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBase64,
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  registerDecorator,
  ValidationOptions,
} from 'class-validator';
import { DateTime } from 'luxon';

/**
 * Upper bound on a timezone identifier's length — IANA zone names are well under
 * this; the cap guards against an unbounded string reaching luxon's resolver.
 */
export const TIMEZONE_MAX_LENGTH = 64;

/**
 * Lower/upper bounds on an editable display name. Empty (after trim) is rejected
 * so a blank submission can't wipe the name to a meaningless value; the upper
 * bound matches the `fullName` cap on `POST /auth/apple`.
 */
export const DISPLAY_NAME_MIN_LENGTH = 1;
export const DISPLAY_NAME_MAX_LENGTH = 200;

/**
 * Upper bound (in encoded characters) on the avatar payload. Mirrors the
 * `avatarBase64` cap on `POST /auth/apple` — comfortably above the ~1 MB JPEG
 * the iOS client produces, while still bounding an unbounded upload.
 */
export const AVATAR_BASE64_MAX_LENGTH = 5_000_000;

/**
 * Returns whether the given string is a valid IANA timezone identifier, using
 * luxon's zone resolver (the same engine the assistant uses for tz-aware
 * arithmetic). An unknown or malformed zone yields an invalid `DateTime`.
 */
export const isValidTimezone = (timezone: string): boolean =>
  DateTime.local().setZone(timezone).isValid;

/**
 * Class-validator constraint asserting a property is a real IANA timezone (e.g.
 * `Europe/Berlin`). Backed by {@link isValidTimezone} so the validity rule is
 * single-sourced with any non-DTO caller.
 */
export const IsTimezone = (validationOptions?: ValidationOptions) => {
  return (object: object, propertyName: string): void => {
    registerDecorator({
      name: 'isTimezone',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          return typeof value === 'string' && isValidTimezone(value);
        },
        defaultMessage(): string {
          return 'timezone must be a valid IANA timezone (e.g. Europe/Berlin).';
        },
      },
    });
  };
};

/**
 * Trims a string value in place during class-transformer's plainToInstance pass;
 * leaves non-strings untouched so the downstream type validators still fire.
 */
const trimString = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/**
 * DTO for PATCH `/users/me/settings`. Every field is optional — the client sends
 * only what changed. `timezone` must be a real IANA zone (every time-of-day-local
 * computation resolves against it); `displayName` is trimmed and length-bounded
 * (previously write-once at `POST /auth/apple`); `avatarBase64` is a bare base64
 * image (no data-URL prefix), size/format validated; `morningBriefEnabled` /
 * `eveningRecapEnabled` are the cross-device notification opt-ins (D8).
 */
export class UpdateUserSettingsDto {
  @ApiPropertyOptional({
    description: 'IANA timezone identifier for the signed-in user.',
    example: 'Europe/Berlin',
    maxLength: TIMEZONE_MAX_LENGTH,
  })
  @IsOptional()
  @IsString()
  @MaxLength(TIMEZONE_MAX_LENGTH)
  @IsTimezone()
  timezone?: string;

  @ApiPropertyOptional({
    description: "The user's display name (trimmed, non-empty).",
    example: 'Jane Appleseed',
    minLength: DISPLAY_NAME_MIN_LENGTH,
    maxLength: DISPLAY_NAME_MAX_LENGTH,
  })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MinLength(DISPLAY_NAME_MIN_LENGTH)
  @MaxLength(DISPLAY_NAME_MAX_LENGTH)
  displayName?: string;

  @ApiPropertyOptional({
    description: 'Base64-encoded profile picture (no data-URL prefix).',
    maxLength: AVATAR_BASE64_MAX_LENGTH,
  })
  @IsOptional()
  @IsString()
  @MaxLength(AVATAR_BASE64_MAX_LENGTH)
  @IsBase64()
  avatarBase64?: string;

  @ApiPropertyOptional({
    description: 'Opt-in to the morning-brief notification.',
    example: true,
  })
  @IsOptional()
  @IsBoolean()
  morningBriefEnabled?: boolean;

  @ApiPropertyOptional({
    description: 'Opt-in to the evening-recap notification.',
    example: true,
  })
  @IsOptional()
  @IsBoolean()
  eveningRecapEnabled?: boolean;
}
