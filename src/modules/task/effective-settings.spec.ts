import { resolveEffectiveSettings } from './effective-settings';
import {
  RecurrenceEndType,
  RecurrenceFrequency,
  Task,
  TaskGroup,
} from '@/modules/database/entities';
import { RecurrenceConfig } from '@/modules/recurrence-rule/recurrence.types';

/** Builds a minimal config POJO for the inheritance assertions. */
const config = (
  overrides: Partial<RecurrenceConfig> = {},
): RecurrenceConfig => ({
  frequency: RecurrenceFrequency.DAILY,
  interval: 1,
  byWeekday: null,
  byMonthDay: null,
  byMonth: null,
  endType: RecurrenceEndType.NEVER,
  endDate: null,
  count: null,
  ...overrides,
});

/** Builds a Task carrying only the fields the resolver reads. */
const task = (overrides: Partial<Task> = {}): Task =>
  ({
    recurrenceConfig: null,
    requiresCompletion: null,
    color: null,
    group: null,
    ...overrides,
  }) as Task;

/** Builds a TaskGroup carrying only the fields the resolver reads. */
const group = (overrides: Partial<TaskGroup> = {}): TaskGroup =>
  ({
    recurrenceConfig: null,
    requiresCompletion: null,
    color: null,
    ...overrides,
  }) as TaskGroup;

describe('resolveEffectiveSettings', () => {
  it('prefers the task own value over the group (task-wins)', () => {
    const taskConfig = config({ frequency: RecurrenceFrequency.WEEKLY });
    const groupConfig = config({ frequency: RecurrenceFrequency.MONTHLY });

    const result = resolveEffectiveSettings(
      task({
        recurrenceConfig: taskConfig,
        requiresCompletion: true,
        color: 'BLUE',
        group: group({
          recurrenceConfig: groupConfig,
          requiresCompletion: false,
          color: 'RED',
        }),
      }),
    );

    expect(result.recurrence).toBe(taskConfig);
    expect(result.requiresCompletion).toBe(true);
    expect(result.color).toBe('BLUE');
  });

  it('falls back to the group value when the task value is null', () => {
    const groupConfig = config({ frequency: RecurrenceFrequency.MONTHLY });

    const result = resolveEffectiveSettings(
      task({
        recurrenceConfig: null,
        requiresCompletion: null,
        color: null,
        group: group({
          recurrenceConfig: groupConfig,
          requiresCompletion: true,
          color: 'GREEN',
        }),
      }),
    );

    expect(result.recurrence).toBe(groupConfig);
    expect(result.requiresCompletion).toBe(true);
    expect(result.color).toBe('GREEN');
  });

  it('defaults requiresCompletion to false (and recurrence/color to null) when set nowhere', () => {
    const result = resolveEffectiveSettings(
      task({ recurrenceConfig: null, requiresCompletion: null, color: null }),
    );

    expect(result.recurrence).toBeNull();
    expect(result.requiresCompletion).toBe(false);
    expect(result.color).toBeNull();
  });

  it('keeps a task requiresCompletion of false over a group true (false is an explicit value)', () => {
    const result = resolveEffectiveSettings(
      task({
        requiresCompletion: false,
        group: group({ requiresCompletion: true }),
      }),
    );

    // `false ?? group` keeps the explicit false — only null falls through.
    expect(result.requiresCompletion).toBe(false);
  });

  it('treats an absent group relation as no group inheritance', () => {
    const result = resolveEffectiveSettings(
      task({ requiresCompletion: null, color: null, group: null }),
    );

    expect(result.requiresCompletion).toBe(false);
    expect(result.color).toBeNull();
  });
});
