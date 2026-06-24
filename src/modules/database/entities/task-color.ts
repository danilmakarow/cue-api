/**
 * Named color presets a Task or TaskGroup may carry. A task/group `color` is
 * EITHER one of these preset names OR a custom `#RRGGBB` hex string — both are
 * accepted and validated at the DTO / tool boundary. Stored as a plain `varchar`
 * (no DB enum) so a custom hex is equally valid without a schema migration.
 */
export enum TaskColor {
  RED = 'RED',
  ORANGE = 'ORANGE',
  YELLOW = 'YELLOW',
  GREEN = 'GREEN',
  TEAL = 'TEAL',
  BLUE = 'BLUE',
  INDIGO = 'INDIGO',
  PURPLE = 'PURPLE',
  PINK = 'PINK',
  BROWN = 'BROWN',
  GRAY = 'GRAY',
}

/** Matches a custom `#RRGGBB` hex color (case-insensitive). */
const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

/** All valid preset color names, as a Set for O(1) membership checks. */
const PRESET_COLOR_NAMES: ReadonlySet<string> = new Set<string>(
  Object.values(TaskColor),
);

/**
 * True when `color` is an accepted task/group color: a known {@link TaskColor}
 * preset name OR a `#RRGGBB` hex string. Shared by the DTO validators and the AI
 * tool schemas so the accepted shape is single-sourced.
 */
export const isValidTaskColor = (color: string): boolean =>
  PRESET_COLOR_NAMES.has(color) || HEX_COLOR_PATTERN.test(color);
