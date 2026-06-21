/**
 * Vendored, dependency-free heuristic detector for the THREE locales the loading
 * -status vocabulary supports — `ru` / `uk` / `en` (v2 Task 4, ADR 0051). It is
 * the FIRST link of the status-locale resolution chain: the message's OWN text
 * drives the loading words, so a user who writes Russian sees Russian loading
 * words even when their Telegram `language_code` is English (the bug ADR 0051
 * fixes). It is intentionally tiny — a full language-ID library (franc / cld) is
 * not warranted for three locales, and the repo convention is to vendor a small
 * detector rather than add a dependency.
 *
 * Heuristic (in priority order, on the message's letters):
 * - Ukrainian-distinctive letters (`і ї є ґ`) ⇒ `uk` — these do not occur in
 *   Russian, so even one is conclusive.
 * - Russian-distinctive letters (`ы ъ э ё`) ⇒ `ru` — these do not occur in
 *   Ukrainian.
 * - Cyrillic with NO distinctive marker (the shared Cyrillic core) ⇒ `ru` — the
 *   safer default for ambiguous Cyrillic (Russian is the far more common input
 *   for this bot, and the spec mandates `ru` here).
 * - Predominantly Latin/other script ⇒ `en`.
 * - Too little signal (no letters, or below the minimum letter count for a
 *   confident Latin call) ⇒ `null`, so the caller falls back to the next link
 *   (Telegram `language_code`, then `en`).
 *
 * Accuracy caveat: this is a script-and-marker heuristic, NOT a statistical
 * model. A short Ukrainian phrase that happens to use only the shared Cyrillic
 * core (no `і ї є ґ`) is reported as `ru`; mixed-script messages are decided by
 * which script's letters dominate. Both are acceptable for picking *loading
 * words* (a cosmetic surface), and the `language_code` fallback covers the
 * inconclusive case.
 */

import type { StatusLocale } from './status-phrases';

/** Letters that occur in Ukrainian but NOT Russian — each is conclusive for `uk`. */
const UKRAINIAN_MARKERS = new Set(['і', 'ї', 'є', 'ґ']);

/** Letters that occur in Russian but NOT Ukrainian — each is conclusive for `ru`. */
const RUSSIAN_MARKERS = new Set(['ы', 'ъ', 'э', 'ё']);

/**
 * Minimum number of LATIN letters before we confidently call a message `en`.
 * Below this we return `null` (inconclusive) rather than guess from a stray word
 * or emoji caption, so the caller falls back to `language_code`. A single
 * distinctive Cyrillic marker is always conclusive regardless of this floor.
 */
const MIN_LATIN_LETTERS_FOR_EN = 2;

/** Matches a Cyrillic letter (the Unicode Cyrillic block, lower/upper). */
const CYRILLIC_LETTER = /[Ѐ-ӿ]/;

/** Matches a Basic-Latin letter (a–z, A–Z). */
const LATIN_LETTER = /[A-Za-z]/;

/**
 * Tallies the letter signals in a message: how many Cyrillic vs. Latin letters
 * it has, and whether any Ukrainian- or Russian-distinctive marker appeared.
 * Punctuation, digits, whitespace, and emojis are ignored (they carry no
 * language signal). Operates on the lower-cased string so marker lookup is
 * case-insensitive.
 */
const tallySignals = (
  text: string,
): {
  cyrillic: number;
  latin: number;
  hasUkrainianMarker: boolean;
  hasRussianMarker: boolean;
} => {
  let cyrillic = 0;
  let latin = 0;
  let hasUkrainianMarker = false;
  let hasRussianMarker = false;

  for (const character of text.toLowerCase()) {
    if (UKRAINIAN_MARKERS.has(character)) {
      hasUkrainianMarker = true;
    }

    if (RUSSIAN_MARKERS.has(character)) {
      hasRussianMarker = true;
    }

    if (CYRILLIC_LETTER.test(character)) {
      cyrillic += 1;

      continue;
    }

    if (LATIN_LETTER.test(character)) {
      latin += 1;
    }
  }

  return { cyrillic, latin, hasUkrainianMarker, hasRussianMarker };
};

/**
 * Detects the message's own language as one of the three supported
 * {@link StatusLocale}s, or `null` when the text is inconclusive (too short / no
 * letters) so the caller can fall back to the Telegram `language_code` and then
 * `en` (v2 Task 4, ADR 0051). Robust to punctuation, digits, emojis, and mixed
 * scripts — only letters are weighed, and the dominant script decides. See the
 * file header for the heuristic and its accuracy caveats.
 */
export const detectMessageLanguage = (
  text: string | undefined,
): StatusLocale | null => {
  if (!text) {
    return null;
  }

  const { cyrillic, latin, hasUkrainianMarker, hasRussianMarker } =
    tallySignals(text);

  // No letters at all (digits / emojis / punctuation only) ⇒ inconclusive.
  if (cyrillic === 0 && latin === 0) {
    return null;
  }

  // Cyrillic dominates ⇒ a Cyrillic-language message. A distinctive marker is
  // conclusive; otherwise the shared Cyrillic core defaults to `ru` (the safer
  // default for ambiguous Cyrillic — ADR 0051).
  if (cyrillic >= latin) {
    if (hasUkrainianMarker) {
      return 'uk';
    }

    if (hasRussianMarker) {
      return 'ru';
    }

    return 'ru';
  }

  // Latin dominates ⇒ English, but only above the confidence floor (a one-letter
  // Latin caption on an otherwise non-letter message is not enough signal).
  if (latin >= MIN_LATIN_LETTERS_FOR_EN) {
    return 'en';
  }

  return null;
};
