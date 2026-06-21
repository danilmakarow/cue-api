/**
 * Loading-status vocabulary + locale selection for the live status message
 * (Story 12, ADR 0012 / ai-workflow-v2-plan Appendix A). Pure + dependency-free
 * so the word-cycle and locale rules are unit-testable in isolation; the
 * {@link StatusAnimatorService} consumes these to drive the animated draft.
 *
 * Selection is by Telegram `language_code`: `uk` ⇒ Ukrainian, `ru` ⇒ Russian,
 * anything else (or absent) ⇒ English. The animating trailing dots are appended
 * by the animator, not here — these are the bare evocative words.
 */

/** The three locales the status vocabulary is authored for. */
export type StatusLocale = 'en' | 'uk' | 'ru';

/** Default locale when `language_code` is absent or unrecognized. */
export const DEFAULT_STATUS_LOCALE: StatusLocale = 'en';

/**
 * The localized "voice is being transcribed" line, shown on the status surface
 * while STT runs (before the normal loading animation begins).
 */
const VOICE_LISTENING: Record<StatusLocale, string> = {
  en: 'Listening to your beautiful voice',
  uk: 'Слухаю ваш чудовий голос',
  ru: 'Слушаю ваш прекрасный голос',
};

/**
 * The cycling loading words per locale (Appendix A). The animator swaps the word
 * every ~5 s, never repeating the immediately-previous one. Bare words — the
 * animator appends the trailing dots.
 */
const LOADING_WORDS: Record<StatusLocale, readonly string[]> = {
  en: [
    'Thinking',
    'Cooking',
    'Brewing',
    'Plotting',
    'Pondering',
    'Conjuring',
    'Scheming',
    'Crunching',
    'Dreaming',
    'Weaving',
    'Calculating',
    'Summoning',
    'Orchestrating',
    'Composing',
    'Untangling',
    'Aligning',
    'Sketching',
    'Percolating',
    'Mulling',
    'Noodling',
    'Assembling',
    'Wrangling',
    'Charting',
    'Distilling',
    'Forging',
    'Marinating',
    'Daydreaming',
    'Tinkering',
    'Synthesizing',
    'Manifesting',
  ],
  uk: [
    'Думаю',
    'Готую',
    'Заварюю',
    'Планую',
    'Міркую',
    'Чаклую',
    'Рахую',
    'Мрію',
    'Плету',
    'Складаю',
    'Креслю',
    'Майструю',
    'Зважую',
    'Вигадую',
    'Кумекаю',
    'Метикую',
    'Збираю',
    'Налаштовую',
    'Компоную',
    'Розплутую',
    'Шукаю',
    'Прикидаю',
    'Обмірковую',
    'Ворожу',
    'Фантазую',
    'Мудрую',
    'Накидаю',
    'Узгоджую',
    'Творю',
    'Готуюся',
  ],
  ru: [
    'Думаю',
    'Готовлю',
    'Завариваю',
    'Планирую',
    'Кумекаю',
    'Колдую',
    'Считаю',
    'Мечтаю',
    'Плету',
    'Собираю',
    'Черчу',
    'Мастерю',
    'Взвешиваю',
    'Придумываю',
    'Соображаю',
    'Прикидываю',
    'Размышляю',
    'Настраиваю',
    'Компоную',
    'Распутываю',
    'Ищу',
    'Ворожу',
    'Фантазирую',
    'Мудрю',
    'Набрасываю',
    'Согласую',
    'Творю',
    'Стряпаю',
    'Замышляю',
    'Химичу',
  ],
};

/**
 * Resolves a Telegram `language_code` (e.g. `en-US`, `uk`, `ru`) to one of the
 * three authored {@link StatusLocale}s. Matches on the primary subtag only and
 * falls back to {@link DEFAULT_STATUS_LOCALE} for anything unrecognized/absent.
 */
export const resolveStatusLocale = (
  languageCode: string | undefined,
): StatusLocale => {
  if (!languageCode) {
    return DEFAULT_STATUS_LOCALE;
  }

  const primary = languageCode.toLowerCase().split('-')[0];

  if (primary === 'uk' || primary === 'ru') {
    return primary;
  }

  return DEFAULT_STATUS_LOCALE;
};

/**
 * Returns the localized voice-listening line for a resolved locale.
 */
export const voiceListeningPhrase = (locale: StatusLocale): string =>
  VOICE_LISTENING[locale];

/**
 * Picks the next loading word for a locale, never returning the immediately
 * previous one (no back-to-back repeat). `previous` is the last word shown (the
 * bare word, no dots); pass `undefined` for the first pick. The choice is random
 * among the remaining words via the injected `random` (0 ≤ r < 1) so tests can
 * make it deterministic; a single-word vocabulary degrades to returning that
 * word (no anti-repeat possible).
 */
export const nextLoadingWord = (
  locale: StatusLocale,
  previous: string | undefined,
  random: () => number = Math.random,
): string => {
  const words = LOADING_WORDS[locale];

  const candidates =
    previous === undefined ? words : words.filter((word) => word !== previous);

  // Defensive: if filtering removed everything (previous was the only word),
  // fall back to the full list so we always return a valid word.
  const pool = candidates.length > 0 ? candidates : words;
  const index = Math.min(pool.length - 1, Math.floor(random() * pool.length));

  return pool[index];
};
