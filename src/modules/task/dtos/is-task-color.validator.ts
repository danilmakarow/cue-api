import { ValidationOptions, registerDecorator } from 'class-validator';

import { isValidTaskColor } from '@/modules/database/entities';

/**
 * class-validator constraint asserting a value is an accepted task/group color:
 * a known {@link TaskColor} preset name OR a custom `#RRGGBB` hex. Reuses the
 * single-sourced {@link isValidTaskColor} predicate so the DTO boundary and the
 * AI-tool schemas accept exactly the same shape. A `null` is rejected here — DTOs
 * that allow clearing pair this with `@IsOptional()` (and accept `null` via the
 * field type), so only a present, non-null value is constraint-checked.
 */
export const IsTaskColor = (
  validationOptions?: ValidationOptions,
): PropertyDecorator => {
  return (object: object, propertyName: string | symbol): void => {
    registerDecorator({
      name: 'isTaskColor',
      target: object.constructor,
      propertyName: propertyName.toString(),
      options: validationOptions,
      validator: {
        validate: (value: unknown): boolean =>
          typeof value === 'string' && isValidTaskColor(value),
        defaultMessage: (): string =>
          'color must be a known preset name or a #RRGGBB hex value',
      },
    });
  };
};
