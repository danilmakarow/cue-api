import {
  ValidationArguments,
  ValidationOptions,
  registerDecorator,
} from 'class-validator';

import { MonthlyAnchorMode } from '../recurrence.types';
import { RecurrenceFrequency } from '@/modules/database/entities';

/**
 * The subset of a recurrence DTO this constraint inspects. Both
 * `CreateRecurrenceRuleDto` and `UpdateRecurrenceRuleDto` structurally satisfy it;
 * `frequency` is optional so the (partial) update DTO can be validated too.
 */
interface MonthlySelectorShape {
  frequency?: RecurrenceFrequency;
  byWeekday?: number[];
  byMonthDay?: number[];
  bySetPos?: number[];
  monthlyAnchor?: MonthlyAnchorMode;
}

/**
 * True when the advanced MONTHLY selectors (`bySetPos` / `monthlyAnchor`) on a
 * recurrence DTO are internally consistent with their documented contract:
 *
 * - `bySetPos` may only appear alongside a non-empty `byWeekday` (it selects the
 *   nth match of `byWeekday`, so it is meaningless without one), and only for
 *   MONTHLY frequency.
 * - `monthlyAnchor` is mutually exclusive with `byMonthDay` / `bySetPos` /
 *   `byWeekday` (it is a standalone working-day anchor), and only for MONTHLY.
 *
 * A `frequency` of `undefined` (partial update payload that does not touch it)
 * skips the MONTHLY-frequency guards — the structural exclusivity guards still
 * apply, since those are independent of the frequency being re-stated.
 */
export const areMonthlySelectorsValid = (
  dto: MonthlySelectorShape,
): boolean => {
  const hasSetPos = dto.bySetPos != null && dto.bySetPos.length > 0;
  const hasAnchor = dto.monthlyAnchor != null;
  const hasWeekday = dto.byWeekday != null && dto.byWeekday.length > 0;
  const hasMonthDay = dto.byMonthDay != null && dto.byMonthDay.length > 0;

  if (!hasSetPos && !hasAnchor) return true;

  const isMonthly =
    dto.frequency === undefined ||
    dto.frequency === RecurrenceFrequency.MONTHLY;

  if (!isMonthly) return false;

  if (hasSetPos && !hasWeekday) return false;

  if (hasAnchor && (hasMonthDay || hasSetPos || hasWeekday)) return false;

  return true;
};

/**
 * Class-level constraint enforcing the cross-field MONTHLY-selector rules
 * (`bySetPos` requires `byWeekday`; `monthlyAnchor` is mutually exclusive with the
 * other selectors; both are MONTHLY-only). Applied to a property so the failure
 * surfaces on that field; `areMonthlySelectorsValid` is the single-sourced
 * predicate, mirroring the `isValidTaskColor` pattern.
 */
export const IsValidMonthlySelectors = (
  validationOptions?: ValidationOptions,
): PropertyDecorator => {
  return (object: object, propertyName: string | symbol): void => {
    registerDecorator({
      name: 'isValidMonthlySelectors',
      target: object.constructor,
      propertyName: propertyName.toString(),
      options: validationOptions,
      validator: {
        validate: (_value: unknown, args?: ValidationArguments): boolean =>
          args === undefined
            ? true
            : areMonthlySelectorsValid(args.object as MonthlySelectorShape),
        defaultMessage: (): string =>
          'bySetPos requires byWeekday and MONTHLY frequency; monthlyAnchor is ' +
          'mutually exclusive with byMonthDay / bySetPos / byWeekday and MONTHLY-only.',
      },
    });
  };
};
