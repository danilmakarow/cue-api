/**
 * Loading-status vocabulary + locale selection for the live status message
 * (Story 12, ADR 0012 / ai-workflow-v2-plan Appendix A). Pure + dependency-free
 * so the word-cycle and locale rules are unit-testable in isolation; the
 * {@link StatusAnimatorService} consumes these to drive the animated draft.
 *
 * Selection follows the user's MESSAGE first (v2 Task 4 / ADR 0051): the
 * message's own language drives the loading words, with the Telegram
 * `language_code` as the fallback and `en` as the final default. We support ONLY
 * `ru` / `uk` / `en`; everything else collapses to `en`. The animating trailing
 * dots are appended by the animator, not here — these are the bare evocative
 * words.
 */

/** The three locales the status vocabulary is authored for. */
export type StatusLocale = 'en' | 'uk' | 'ru';

/** Default locale when `language_code` is absent or unrecognized. */
export const DEFAULT_STATUS_LOCALE: StatusLocale = 'en';

/**
 * The terminal-style braille spinner frames (R1 / ADR 0057) cycled on the status
 * surface to animate the loading line in place. The classic 10-frame set; index
 * `frame mod 10` selects the current glyph. Authored here (next to the loading
 * vocabulary) so the rendering helper stays pure and dependency-free.
 */
export const SPINNER_FRAMES = [
  '⠋',
  '⠙',
  '⠹',
  '⠸',
  '⠼',
  '⠴',
  '⠦',
  '⠧',
  '⠇',
  '⠏',
] as const;

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
 * Resolves a language CODE (a Telegram `language_code` like `en-US`/`uk`/`ru`, or
 * an STT-reported language like `russian`/`uk`/`ISO`) to one of the three authored
 * {@link StatusLocale}s, or `null` when it maps to none of them. Matches on the
 * primary subtag (so `ru-RU` ⇒ `ru`) AND on the common English spelled-out names
 * some STT models report (`russian` / `ukrainian` / `english`), case-insensitively.
 * Returns `null` (not the default) so a CALLER deciding a resolution chain can tell
 * "this code is unsupported" from "this code is `en`" and fall through correctly.
 */
const mapCodeToLocale = (
  languageCode: string | undefined,
): StatusLocale | null => {
  if (!languageCode) {
    return null;
  }

  const normalized = languageCode.toLowerCase().trim();
  const primary = normalized.split('-')[0];

  if (primary === 'uk' || normalized === 'ukrainian') {
    return 'uk';
  }

  if (primary === 'ru' || normalized === 'russian') {
    return 'ru';
  }

  if (primary === 'en' || normalized === 'english') {
    return 'en';
  }

  return null;
};

/**
 * Resolves a Telegram `language_code` (e.g. `en-US`, `uk`, `ru`) to one of the
 * three authored {@link StatusLocale}s. Matches on the primary subtag only; when
 * the code is unrecognized/absent it falls back to the optional `fallbackLocale`
 * — the prior turn's language borrowed for the VOICE pre-STT "Listening…" line,
 * which has no text to detect yet (R2 / ADR 0055) — and finally to
 * {@link DEFAULT_STATUS_LOCALE}. Still the fallback link of the
 * text/voice-post-STT chains.
 */
export const resolveStatusLocale = (
  languageCode: string | undefined,
  fallbackLocale?: StatusLocale,
): StatusLocale =>
  mapCodeToLocale(languageCode) ?? fallbackLocale ?? DEFAULT_STATUS_LOCALE;

/**
 * Resolves the loading-status locale for a TEXT turn (v2 Task 4 / ADR 0051), in
 * priority order: (1) the message's OWN detected language when conclusive — this
 * is what makes a Russian message show Russian loading words even under an English
 * `language_code` (the bug ADR 0051 fixes); (2) else the Telegram `language_code`
 * when it maps to a supported locale; (3) else the optional `fallbackLocale` — the
 * language the user wrote in on a PRIOR turn (R2 / ADR 0055), borrowed so a
 * signal-poor message keeps the conversation's language instead of snapping to
 * `en`; (4) else `en`. `detect` is injected (the vendored
 * {@link detectMessageLanguage}) so the chain stays pure + unit-testable with a
 * stub and status-phrases keeps no hard import of the detector. `fallbackLocale`
 * is passed in (never imported from the store) so the chain stays pure.
 */
export const resolveTextStatusLocale = (
  messageText: string | undefined,
  languageCode: string | undefined,
  detect: (text: string | undefined) => StatusLocale | null,
  fallbackLocale?: StatusLocale,
): StatusLocale => {
  const detected = detect(messageText);

  if (detected) {
    return detected;
  }

  return (
    mapCodeToLocale(languageCode) ?? fallbackLocale ?? DEFAULT_STATUS_LOCALE
  );
};

/**
 * Resolves the loading-status locale for a voice turn AFTER STT (v2 Task 4 / ADR
 * 0051), in priority order: (1) the STT-reported spoken language when it maps to a
 * supported locale; (2) else the language detected from the TRANSCRIPT when
 * conclusive; (3) else the Telegram `language_code` when supported; (4) else the
 * optional `fallbackLocale` — the prior turn's language borrowed for a signal-poor
 * turn (R2 / ADR 0055); (5) else `en`. This re-resolves the SAME idempotent status
 * surface once the words are known, so the ongoing loading animation switches to
 * the spoken language. `detect` is injected (the vendored
 * {@link detectMessageLanguage}); the pre-STT "Listening…" line uses
 * {@link resolveStatusLocale} on the `language_code` alone (no text exists yet),
 * now with its OWN borrowed fallback (R2). `fallbackLocale` is passed in (never
 * imported from the store) so the chain stays pure.
 */
export const resolveVoiceStatusLocale = (
  sttLanguage: string | undefined,
  transcript: string | undefined,
  languageCode: string | undefined,
  detect: (text: string | undefined) => StatusLocale | null,
  fallbackLocale?: StatusLocale,
): StatusLocale => {
  const fromStt = mapCodeToLocale(sttLanguage);

  if (fromStt) {
    return fromStt;
  }

  const fromTranscript = detect(transcript);

  if (fromTranscript) {
    return fromTranscript;
  }

  return (
    mapCodeToLocale(languageCode) ?? fallbackLocale ?? DEFAULT_STATUS_LOCALE
  );
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

/**
 * Builds the animated loading line for a given spinner tick (R1 / ADR 0057):
 * prepends the current {@link SPINNER_FRAMES} glyph to the (already-localized)
 * loading `word`. Pure + dependency-free like {@link nextLoadingWord} so the
 * frame cadence is unit-testable; the caller animates ONE captured word across
 * ticks rather than re-picking. NO trailing ellipsis — the rotating spinner
 * frame replaces the old static dots, which fought Telegram's own indicator.
 * `frameIndex` is wrapped modulo the frame count, so any monotonically growing
 * tick counter is a valid input.
 */
export const spinnerLoadingLine = (
  word: string,
  frameIndex: number,
): string => {
  const frame = SPINNER_FRAMES[frameIndex % SPINNER_FRAMES.length];

  return `${frame} ${word}`;
};
