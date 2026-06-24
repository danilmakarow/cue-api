import {
  KEYBOARD_LABELS,
  KeyboardAction,
  KeyboardSurface,
  MAIN_KEYBOARD,
  MENU_KEYBOARD,
  SETTINGS_KEYBOARD,
  resolveKeyboardAction,
  toKeyboardSurface,
} from './reply-keyboard.layout';

describe('reply-keyboard layout', () => {
  it("the main keyboard offers [Today's schedule] [Next week] [Settings] and [Open Menu]", () => {
    expect(MAIN_KEYBOARD.buttons.flat().map((button) => button.label)).toEqual([
      KEYBOARD_LABELS.todaySchedule,
      KEYBOARD_LABELS.nextWeek,
      KEYBOARD_LABELS.settings,
      KEYBOARD_LABELS.openMenu,
    ]);
  });

  it('the settings keyboard offers exactly [Disconnect] [Back]', () => {
    expect(
      SETTINGS_KEYBOARD.buttons.flat().map((button) => button.label),
    ).toEqual([KEYBOARD_LABELS.disconnect, KEYBOARD_LABELS.back]);
  });

  it('the menu keyboard offers [Settings] [Logout] and [Close] (the Back label)', () => {
    expect(MENU_KEYBOARD.buttons.flat().map((button) => button.label)).toEqual([
      KEYBOARD_LABELS.settings,
      KEYBOARD_LABELS.logout,
      KEYBOARD_LABELS.back,
    ]);
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

  it('narrows only the three known surface values, everything else to null', () => {
    expect(toKeyboardSurface('main')).toBe(KeyboardSurface.Main);
    expect(toKeyboardSurface('settings')).toBe(KeyboardSurface.Settings);
    expect(toKeyboardSurface('menu')).toBe(KeyboardSurface.Menu);
    expect(toKeyboardSurface(null)).toBeNull();
    expect(toKeyboardSurface('')).toBeNull();
    expect(toKeyboardSurface('garbage')).toBeNull();
  });

  // --- R4 / ADR 0056: 'Open Menu' is globally owned across every docked surface ---

  it("resolves 'Open Menu' to OpenMenu on EVERY docked surface (globally owned)", () => {
    for (const surface of [
      KeyboardSurface.Main,
      KeyboardSurface.Settings,
      KeyboardSurface.Menu,
    ]) {
      expect(resolveKeyboardAction(surface, KEYBOARD_LABELS.openMenu)).toBe(
        KeyboardAction.OpenMenu,
      );
    }
  });

  it('resolves the Menu surface labels to their menu-specific actions', () => {
    expect(
      resolveKeyboardAction(KeyboardSurface.Menu, KEYBOARD_LABELS.settings),
    ).toBe(KeyboardAction.MenuSettings);
    expect(
      resolveKeyboardAction(KeyboardSurface.Menu, KEYBOARD_LABELS.logout),
    ).toBe(KeyboardAction.Logout);
    expect(
      resolveKeyboardAction(KeyboardSurface.Menu, KEYBOARD_LABELS.back),
    ).toBe(KeyboardAction.CloseMenu);
  });

  it("the Main surface keeps [Settings] mapped to OpenSettings (NOT the menu's MenuSettings)", () => {
    expect(
      resolveKeyboardAction(KeyboardSurface.Main, KEYBOARD_LABELS.settings),
    ).toBe(KeyboardAction.OpenSettings);
  });

  it('the Logout label is inert on the Main and Settings surfaces (only the Menu owns it)', () => {
    expect(
      resolveKeyboardAction(KeyboardSurface.Main, KEYBOARD_LABELS.logout),
    ).toBeNull();
    expect(
      resolveKeyboardAction(KeyboardSurface.Settings, KEYBOARD_LABELS.logout),
    ).toBeNull();
  });
});
