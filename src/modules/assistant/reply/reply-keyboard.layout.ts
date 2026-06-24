/**
 * L9 reply-keyboard layout — the single source of truth for the persistent
 * reply-keyboard surfaces the assistant docks (Story 16 / ADR 0045) and the
 * text-equality routing of their taps. Reply-keyboard taps arrive as PLAIN TEXT
 * equal to the button label (NOT a callback — Verified Telegram facts, ADR 0012),
 * so the label IS the routing key. Keeping the labels, the per-surface keyboards,
 * and the label→action map in ONE module means the surface a user sees, the
 * active-surface flag the router gates on, and the action the tap resolves to can
 * never drift apart.
 *
 * Three surfaces: the MAIN keyboard ([Today's schedule] [Next week] [Settings] +
 * [Open Menu]), the SETTINGS keyboard ([Disconnect] [Back]), and the MENU keyboard
 * ([Settings] [Logout] + [Close], R4 / ADR 0056). All are persistent
 * (`is_persistent` + `resize_keyboard`, via the Story-10 primitive); swapping one
 * for another is just sending a new message with the other's markup, and Disconnect
 * / Logout removes the keyboard entirely (`ReplyKeyboardRemove`). 'Open Menu' is
 * globally owned across surfaces so it routes regardless of the docked surface.
 *
 * See `docs/specs/assistant-layered-architecture.md` → L9 reply/egress.
 */

import { ReplyKeyboard } from '@/modules/external-vendor/external-vendor.types';

/**
 * Stable identifier of which reply-keyboard surface is docked for a user. Stored
 * verbatim as the value of the active-surface Redis flag, so the router can both
 * test "is a keyboard active?" (key present) and "does THIS keyboard own the
 * tapped label?" (its label set) without re-deriving the layout.
 */
export enum KeyboardSurface {
  Main = 'main',
  Settings = 'settings',
  Menu = 'menu',
}

/** The action a reply-keyboard tap resolves to (all deterministic — NO LLM). */
export enum KeyboardAction {
  /** [Today's schedule] — render today's ASCII calendar. */
  TodaySchedule = 'today_schedule',
  /** [Next week] — render the next 7-day ASCII calendar. */
  NextWeek = 'next_week',
  /** [Settings] — swap the main keyboard for the settings keyboard. */
  OpenSettings = 'open_settings',
  /** [Disconnect] — unlink Telegram and remove the keyboard. */
  Disconnect = 'disconnect',
  /** [Back] — swap the settings keyboard back to the main keyboard. */
  Back = 'back',
  /**
   * [Open Menu] — dock the persistent Menu surface (account + status card),
   * dedup-replacing any prior menu message (R4 / ADR 0056). Globally owned on
   * EVERY docked surface so it routes regardless of which surface is active.
   */
  OpenMenu = 'open_menu',
  /** [Settings] (Menu surface) — open the settings keyboard from the menu. */
  MenuSettings = 'menu_settings',
  /** [Logout] (Menu surface) — unlink Telegram and remove the keyboard. */
  Logout = 'logout',
  /** [Close] (Menu surface) — return to the main keyboard. */
  CloseMenu = 'close_menu',
}

/** Button labels — the verbatim text a tap echoes back as inbound plain text. */
export const KEYBOARD_LABELS = {
  todaySchedule: "Today's schedule",
  nextWeek: 'Next week',
  settings: 'Settings',
  disconnect: 'Disconnect',
  back: 'Back',
  openMenu: 'Open Menu',
  logout: 'Logout',
} as const;

/**
 * The main reply keyboard: [Today's schedule] [Next week] [Settings] on the first
 * row and [Open Menu] on the second, so the menu surface is reachable from normal
 * chat (R4 / ADR 0056).
 */
export const MAIN_KEYBOARD: ReplyKeyboard = {
  buttons: [
    [
      { label: KEYBOARD_LABELS.todaySchedule },
      { label: KEYBOARD_LABELS.nextWeek },
      { label: KEYBOARD_LABELS.settings },
    ],
    [{ label: KEYBOARD_LABELS.openMenu }],
  ],
};

/** The settings reply keyboard: one row of [Disconnect] [Back]. */
export const SETTINGS_KEYBOARD: ReplyKeyboard = {
  buttons: [
    [{ label: KEYBOARD_LABELS.disconnect }, { label: KEYBOARD_LABELS.back }],
  ],
};

/**
 * The menu reply keyboard (R4 / ADR 0056): [Settings] [Logout] on the first row
 * and [Close] on the second. It is docked alongside the account/status card; the
 * menu message itself is dedup-deleted on the next [Open Menu] so the chat never
 * accumulates stale cards.
 */
export const MENU_KEYBOARD: ReplyKeyboard = {
  buttons: [
    [{ label: KEYBOARD_LABELS.settings }, { label: KEYBOARD_LABELS.logout }],
    [{ label: KEYBOARD_LABELS.back }],
  ],
};

/**
 * Maps each surface to the label→action table of the buttons it owns. The router
 * resolves a tapped label to an action ONLY through the table of the CURRENTLY
 * docked surface, so a label that exists on another surface is never honoured out
 * of context (e.g. "Back" is inert while the main keyboard is docked).
 */
const SURFACE_ACTIONS: Record<
  KeyboardSurface,
  Record<string, KeyboardAction>
> = {
  [KeyboardSurface.Main]: {
    [KEYBOARD_LABELS.todaySchedule]: KeyboardAction.TodaySchedule,
    [KEYBOARD_LABELS.nextWeek]: KeyboardAction.NextWeek,
    [KEYBOARD_LABELS.settings]: KeyboardAction.OpenSettings,
    // 'Open Menu' is globally owned on EVERY docked surface (R4 / ADR 0056) so a
    // tap routes to OpenMenu regardless of which surface is currently active —
    // otherwise the active-surface gate would treat it as plain chat.
    [KEYBOARD_LABELS.openMenu]: KeyboardAction.OpenMenu,
  },
  [KeyboardSurface.Settings]: {
    [KEYBOARD_LABELS.disconnect]: KeyboardAction.Disconnect,
    [KEYBOARD_LABELS.back]: KeyboardAction.Back,
    // 'Open Menu' is globally owned (see above) — also routed while Settings is
    // docked even though Settings does not render the button itself.
    [KEYBOARD_LABELS.openMenu]: KeyboardAction.OpenMenu,
  },
  [KeyboardSurface.Menu]: {
    // The Menu surface re-uses the [Settings] / [Back] labels for its own actions:
    // [Settings] opens the settings keyboard, [Back] closes the menu back to main,
    // [Logout] unlinks. 'Open Menu' stays globally owned (idempotent re-open).
    [KEYBOARD_LABELS.settings]: KeyboardAction.MenuSettings,
    [KEYBOARD_LABELS.logout]: KeyboardAction.Logout,
    [KEYBOARD_LABELS.back]: KeyboardAction.CloseMenu,
    [KEYBOARD_LABELS.openMenu]: KeyboardAction.OpenMenu,
  },
};

/**
 * Resolves a tapped label to its {@link KeyboardAction} WITHIN the docked surface,
 * or null when the docked surface does not own that label. This is the precise
 * disambiguation that prevents hijacking a typed label: a message is a keyboard
 * action only when the surface is active (the caller already checked the flag is
 * present) AND that surface actually owns the exact label.
 */
export const resolveKeyboardAction = (
  surface: KeyboardSurface,
  label: string,
): KeyboardAction | null => {
  return SURFACE_ACTIONS[surface][label] ?? null;
};

/**
 * Narrows a raw stored flag value to a {@link KeyboardSurface}, or null when the
 * value is absent/unknown (no keyboard is the active surface). Keeps the router's
 * gate total — a corrupt or missing flag simply means "not a keyboard action".
 */
export const toKeyboardSurface = (
  value: string | null,
): KeyboardSurface | null => {
  if (
    value === KeyboardSurface.Main ||
    value === KeyboardSurface.Settings ||
    value === KeyboardSurface.Menu
  ) {
    return value;
  }

  return null;
};
