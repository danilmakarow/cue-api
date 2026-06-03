import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { CreateRecurrenceRuleDto } from './create-recurrence-rule.dto';
import { UpdateRecurrenceRuleDto } from './update-recurrence-rule.dto';
import {
  RecurrenceEndType,
  RecurrenceFrequency,
} from '@/modules/database/entities';

/**
 * Validates a plain payload through a DTO class and returns the set of property
 * names that failed validation.
 */
const failingProps = async (
  cls: typeof CreateRecurrenceRuleDto | typeof UpdateRecurrenceRuleDto,
  payload: Record<string, unknown>,
): Promise<string[]> => {
  const instance = plainToInstance(cls, payload);
  const errors = await validate(instance);

  return errors.map((error) => error.property);
};

describe('CreateRecurrenceRuleDto', () => {
  it('accepts a minimal NEVER weekly rule', async () => {
    expect(
      await failingProps(CreateRecurrenceRuleDto, {
        frequency: RecurrenceFrequency.WEEKLY,
      }),
    ).toEqual([]);
  });

  it('rejects a missing/invalid frequency', async () => {
    expect(await failingProps(CreateRecurrenceRuleDto, {})).toContain(
      'frequency',
    );
    expect(
      await failingProps(CreateRecurrenceRuleDto, { frequency: 'HOURLY' }),
    ).toContain('frequency');
  });

  it('rejects interval below 1', async () => {
    expect(
      await failingProps(CreateRecurrenceRuleDto, {
        frequency: RecurrenceFrequency.DAILY,
        interval: 0,
      }),
    ).toContain('interval');
  });

  it('requires count when endType is COUNT', async () => {
    expect(
      await failingProps(CreateRecurrenceRuleDto, {
        frequency: RecurrenceFrequency.DAILY,
        endType: RecurrenceEndType.COUNT,
      }),
    ).toContain('count');
  });

  it('rejects a non-positive count for COUNT', async () => {
    expect(
      await failingProps(CreateRecurrenceRuleDto, {
        frequency: RecurrenceFrequency.DAILY,
        endType: RecurrenceEndType.COUNT,
        count: 0,
      }),
    ).toContain('count');
  });

  it('accepts COUNT with a positive count', async () => {
    expect(
      await failingProps(CreateRecurrenceRuleDto, {
        frequency: RecurrenceFrequency.DAILY,
        endType: RecurrenceEndType.COUNT,
        count: 12,
      }),
    ).toEqual([]);
  });

  it('requires endDate when endType is UNTIL_DATE', async () => {
    expect(
      await failingProps(CreateRecurrenceRuleDto, {
        frequency: RecurrenceFrequency.DAILY,
        endType: RecurrenceEndType.UNTIL_DATE,
      }),
    ).toContain('endDate');
  });

  it('accepts UNTIL_DATE with a valid endDate', async () => {
    expect(
      await failingProps(CreateRecurrenceRuleDto, {
        frequency: RecurrenceFrequency.DAILY,
        endType: RecurrenceEndType.UNTIL_DATE,
        endDate: '2026-07-31',
      }),
    ).toEqual([]);
  });

  it('rejects byWeekday outside 0–6', async () => {
    expect(
      await failingProps(CreateRecurrenceRuleDto, {
        frequency: RecurrenceFrequency.WEEKLY,
        byWeekday: [0, 7],
      }),
    ).toContain('byWeekday');
  });

  it('accepts byWeekday within 0–6', async () => {
    expect(
      await failingProps(CreateRecurrenceRuleDto, {
        frequency: RecurrenceFrequency.WEEKLY,
        byWeekday: [0, 1, 2, 3, 4, 5, 6],
      }),
    ).toEqual([]);
  });

  it('rejects byMonthDay outside 1–31', async () => {
    expect(
      await failingProps(CreateRecurrenceRuleDto, {
        frequency: RecurrenceFrequency.MONTHLY,
        byMonthDay: [0],
      }),
    ).toContain('byMonthDay');
    expect(
      await failingProps(CreateRecurrenceRuleDto, {
        frequency: RecurrenceFrequency.MONTHLY,
        byMonthDay: [32],
      }),
    ).toContain('byMonthDay');
  });

  it('rejects byMonth outside 1–12', async () => {
    expect(
      await failingProps(CreateRecurrenceRuleDto, {
        frequency: RecurrenceFrequency.YEARLY,
        byMonth: [13],
      }),
    ).toContain('byMonth');
  });

  it('rejects an empty by-array', async () => {
    expect(
      await failingProps(CreateRecurrenceRuleDto, {
        frequency: RecurrenceFrequency.WEEKLY,
        byWeekday: [],
      }),
    ).toContain('byWeekday');
  });
});

describe('UpdateRecurrenceRuleDto', () => {
  it('accepts an empty partial payload', async () => {
    expect(await failingProps(UpdateRecurrenceRuleDto, {})).toEqual([]);
  });

  it('accepts a lone interval bump', async () => {
    expect(
      await failingProps(UpdateRecurrenceRuleDto, { interval: 4 }),
    ).toEqual([]);
  });

  it('enforces count when the payload switches endType to COUNT', async () => {
    expect(
      await failingProps(UpdateRecurrenceRuleDto, {
        endType: RecurrenceEndType.COUNT,
      }),
    ).toContain('count');
  });

  it('enforces endDate when the payload switches endType to UNTIL_DATE', async () => {
    expect(
      await failingProps(UpdateRecurrenceRuleDto, {
        endType: RecurrenceEndType.UNTIL_DATE,
      }),
    ).toContain('endDate');
  });

  it('rejects invalid weekday ordinals', async () => {
    expect(
      await failingProps(UpdateRecurrenceRuleDto, { byWeekday: [-1] }),
    ).toContain('byWeekday');
  });
});
