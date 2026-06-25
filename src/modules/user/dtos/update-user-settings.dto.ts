import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  MaxLength,
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
 * DTO for PATCH `/users/me/settings`. `timezone` is optional — the client sends
 * only what changed — but when present it must be a valid IANA zone; an unknown
 * or malformed value is rejected with 400 rather than stored, since every
 * time-of-day-local computation (recurrence, daily report) resolves against it.
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
}
