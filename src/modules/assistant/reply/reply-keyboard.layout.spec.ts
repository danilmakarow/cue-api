import {
  KEYBOARD_LABELS,
  KeyboardAction,
  KeyboardSurface,
  MAIN_KEYBOARD,
  SETTINGS_KEYBOARD,
  resolveKeyboardAction,
  toKeyboardSurface,
} from './reply-keyboard.layout';

describe('reply-keyboard layout', () => {
  it("the main keyboard offers exactly [Today's schedule] [Next week] [Settings]", () => {
    expect(MAIN_KEYBOARD.buttons.flat().map((button) => button.label)).toEqual([
      KEYBOARD_LABELS.todaySchedule,
      KEYBOARD_LABELS.nextWeek,
      KEYBOARD_LABELS.settings,
    ]);
  });

  it('the settings keyboard offers exactly [Disconnect] [Back]', () => {
    expect(
      SETTINGS_KEYBOARD.buttons.flat().map((button) => button.label),
    ).toEqual([KEYBOARD_LABELS.disconnect, KEYBOARD_LABELS.back]);
  });

  it('resolves a label ONLY within the surface that owns it', () => {
    expect(
      resolveKeyboardAction(
        KeyboardSurface.Main,
        KEYBOARD_LABELS.todaySchedule,
      ),
    ).toBe(KeyboardAction.TodaySchedule);
    expect(
      resolveKeyboardAction(KeyboardSurface.Settings, KEYBOARD_LABELS.back),
    ).toBe(KeyboardAction.Back);
  });

  it('returns null for a label the docked surface does not own (cross-surface labels are inert)', () => {
    // "Back" belongs to the settings surface — inert while main is docked.
    expect(
      resolveKeyboardAction(KeyboardSurface.Main, KEYBOARD_LABELS.back),
    ).toBeNull();
    // "Today's schedule" belongs to the main surface — inert while settings is docked.
    expect(
      resolveKeyboardAction(
        KeyboardSurface.Settings,
        KEYBOARD_LABELS.todaySchedule,
      ),
    ).toBeNull();
  });

  it('returns null for an arbitrary non-label string (a typed sentence is never an action)', () => {
    expect(
      resolveKeyboardAction(KeyboardSurface.Main, 'what is on settings today'),
    ).toBeNull();
  });

  it('narrows only the two known surface values, everything else to null', () => {
    expect(toKeyboardSurface('main')).toBe(KeyboardSurface.Main);
    expect(toKeyboardSurface('settings')).toBe(KeyboardSurface.Settings);
    expect(toKeyboardSurface(null)).toBeNull();
    expect(toKeyboardSurface('')).toBeNull();
    expect(toKeyboardSurface('garbage')).toBeNull();
  });
});
