import { detectMessageLanguage } from './detect-message-language';
import {
  DEFAULT_STATUS_LOCALE,
  nextLoadingWord,
  resolveStatusLocale,
  resolveTextStatusLocale,
  resolveVoiceStatusLocale,
  SPINNER_FRAMES,
  spinnerLoadingLine,
  voiceListeningPhrase,
} from './status-phrases';

describe('status-phrases (Story 12 / Appendix A)', () => {
  describe('resolveStatusLocale', () => {
    it('maps uk / ru primary subtags to their locales', () => {
      expect(resolveStatusLocale('uk')).toBe('uk');
      expect(resolveStatusLocale('ru')).toBe('ru');
      expect(resolveStatusLocale('ru-RU')).toBe('ru');
      expect(resolveStatusLocale('uk-UA')).toBe('uk');
    });

    it('falls back to the default locale for English / unknown / absent', () => {
      expect(resolveStatusLocale('en')).toBe(DEFAULT_STATUS_LOCALE);
      expect(resolveStatusLocale('en-US')).toBe('en');
      expect(resolveStatusLocale('fr')).toBe('en');
      expect(resolveStatusLocale(undefined)).toBe('en');
      expect(resolveStatusLocale('')).toBe('en');
    });

    it('is case-insensitive on the language tag', () => {
      expect(resolveStatusLocale('RU')).toBe('ru');
      expect(resolveStatusLocale('Uk-Ua')).toBe('uk');
    });

    it('borrows the fallback locale when the language_code is unsupported/absent (R2 / ADR 0055)', () => {
      // The voice pre-STT line has no text — an unsupported/absent code falls back
      // to the prior turn's borrowed locale instead of bare en.
      expect(resolveStatusLocale('fr', 'ru')).toBe('ru');
      expect(resolveStatusLocale(undefined, 'uk')).toBe('uk');
      // A SUPPORTED code still wins over the borrowed fallback.
      expect(resolveStatusLocale('ru', 'uk')).toBe('ru');
      // No fallback ⇒ still en.
      expect(resolveStatusLocale('fr')).toBe('en');
    });
  });

  describe('resolveTextStatusLocale (v2 Task 4 / ADR 0051 — message-text priority)', () => {
    it('uses the message-detected language when conclusive, OVERRIDING the language_code', () => {
      // The bug ADR 0051 fixes: a Russian message under an English language_code
      // must show Russian loading words. Message text wins.
      expect(
        resolveTextStatusLocale(
          'перенеси встречу на завтра',
          'en',
          detectMessageLanguage,
        ),
      ).toBe('ru');
      // A Ukrainian message (distinctive і) under an English code → uk.
      expect(
        resolveTextStatusLocale(
          'перенеси зустріч на завтра',
          'en-US',
          detectMessageLanguage,
        ),
      ).toBe('uk');
      // An English message under a Russian code → en (message still wins).
      expect(
        resolveTextStatusLocale(
          'move my meeting to tomorrow',
          'ru',
          detectMessageLanguage,
        ),
      ).toBe('en');
    });

    it('falls back to a SUPPORTED language_code when the message is inconclusive', () => {
      // Digits/emoji only → detector returns null → use the language_code.
      expect(
        resolveTextStatusLocale('15:30 👍', 'ru', detectMessageLanguage),
      ).toBe('ru');
      expect(resolveTextStatusLocale('', 'uk-UA', detectMessageLanguage)).toBe(
        'uk',
      );
    });

    it('falls back to en when the message is inconclusive AND the language_code is unsupported/absent', () => {
      expect(resolveTextStatusLocale('123', 'fr', detectMessageLanguage)).toBe(
        'en',
      );
      expect(
        resolveTextStatusLocale('???', undefined, detectMessageLanguage),
      ).toBe('en');
    });

    it('borrows the fallback locale below the language_code when both are inconclusive (R2 / ADR 0055)', () => {
      // Inconclusive text + unsupported/absent code ⇒ borrow the prior turn locale.
      expect(
        resolveTextStatusLocale('123', 'fr', detectMessageLanguage, 'ru'),
      ).toBe('ru');
      expect(
        resolveTextStatusLocale('???', undefined, detectMessageLanguage, 'uk'),
      ).toBe('uk');
      // A SUPPORTED language_code still wins over the borrowed fallback.
      expect(
        resolveTextStatusLocale('123', 'uk', detectMessageLanguage, 'ru'),
      ).toBe('uk');
      // Conclusive message text still wins over everything.
      expect(
        resolveTextStatusLocale(
          'перенеси встречу',
          'fr',
          detectMessageLanguage,
          'uk',
        ),
      ).toBe('ru');
    });
  });

  describe('resolveVoiceStatusLocale (v2 Task 4 / ADR 0051 — STT-first post-STT chain)', () => {
    it('uses the STT-reported language when it maps to a supported locale (highest priority)', () => {
      // STT language wins over BOTH the transcript and the language_code.
      expect(
        resolveVoiceStatusLocale(
          'ru',
          'move my meeting',
          'en',
          detectMessageLanguage,
        ),
      ).toBe('ru');
      // Spelled-out STT language names are mapped too.
      expect(
        resolveVoiceStatusLocale(
          'ukrainian',
          'move my meeting',
          'en',
          detectMessageLanguage,
        ),
      ).toBe('uk');
    });

    it('falls back to detecting the transcript when STT language is absent/unsupported', () => {
      expect(
        resolveVoiceStatusLocale(
          undefined,
          'перенеси встречу на завтра',
          'en',
          detectMessageLanguage,
        ),
      ).toBe('ru');
      // STT reported an unsupported language → detect the transcript (uk via і).
      expect(
        resolveVoiceStatusLocale(
          'fr',
          'перенеси зустріч на завтра',
          'en',
          detectMessageLanguage,
        ),
      ).toBe('uk');
    });

    it('falls back to the language_code then en when STT + transcript are both inconclusive', () => {
      expect(
        resolveVoiceStatusLocale(undefined, '123', 'uk', detectMessageLanguage),
      ).toBe('uk');
      expect(
        resolveVoiceStatusLocale(undefined, '123', 'fr', detectMessageLanguage),
      ).toBe('en');
    });

    it('borrows the fallback locale below the language_code when STT/transcript/code are all inconclusive (R2 / ADR 0055)', () => {
      // The most important case for R2: a voice note where nothing else resolves
      // borrows the prior turn's language instead of snapping to en.
      expect(
        resolveVoiceStatusLocale(
          undefined,
          '123',
          'fr',
          detectMessageLanguage,
          'ru',
        ),
      ).toBe('ru');
      // A SUPPORTED language_code still wins over the borrowed fallback.
      expect(
        resolveVoiceStatusLocale(
          undefined,
          '123',
          'uk',
          detectMessageLanguage,
          'ru',
        ),
      ).toBe('uk');
      // The STT language still wins over everything.
      expect(
        resolveVoiceStatusLocale(
          'ru',
          '123',
          'fr',
          detectMessageLanguage,
          'uk',
        ),
      ).toBe('ru');
    });
  });

  describe('voiceListeningPhrase', () => {
    it('returns the localized voice line per locale', () => {
      expect(voiceListeningPhrase('en')).toBe(
        'Listening to your beautiful voice',
      );
      expect(voiceListeningPhrase('uk')).toBe('Слухаю ваш чудовий голос');
      expect(voiceListeningPhrase('ru')).toBe('Слушаю ваш прекрасный голос');
    });
  });

  describe('nextLoadingWord', () => {
    it('never returns the immediately-previous word (no back-to-back repeat)', () => {
      // Drive 200 picks with a real RNG; assert no consecutive duplicate and that
      // every previous word is excluded from its own next pick.
      let previous = nextLoadingWord('en', undefined);

      for (let index = 0; index < 200; index += 1) {
        const next = nextLoadingWord('en', previous);

        expect(next).not.toBe(previous);
        previous = next;
      }
    });

    it('selects from the locale-specific vocabulary', () => {
      // A deterministic random pinned to 0 picks the first candidate of each pool.
      const enFirst = nextLoadingWord('en', undefined, () => 0);
      const ukFirst = nextLoadingWord('uk', undefined, () => 0);
      const ruFirst = nextLoadingWord('ru', undefined, () => 0);

      expect(enFirst).toBe('Thinking');
      expect(ukFirst).toBe('Думаю');
      expect(ruFirst).toBe('Думаю'); // ru list also starts with Думаю
    });

    it('excludes the previous word so the candidate pool shifts', () => {
      // With random→0 and previous='Thinking' (the first en word), the first
      // candidate of the FILTERED pool is the second word, 'Cooking'.
      expect(nextLoadingWord('en', 'Thinking', () => 0)).toBe('Cooking');
    });

    it('clamps a random value of 1 to the last candidate (no out-of-range)', () => {
      const word = nextLoadingWord('en', undefined, () => 1);

      expect(word).toBe('Manifesting'); // last en word
    });
  });

  describe('spinnerLoadingLine (R1 / ADR 0057)', () => {
    it('prepends the frame-0 glyph to the word with NO trailing ellipsis', () => {
      expect(spinnerLoadingLine('Thinking', 0)).toBe(
        `${SPINNER_FRAMES[0]} Thinking`,
      );
      // The spinner replaces the old static dots — no trailing ellipsis remains.
      expect(spinnerLoadingLine('Thinking', 0)).not.toMatch(/…$/);
    });

    it('advances through the frame set as the index grows', () => {
      expect(spinnerLoadingLine('Готую', 1)).toBe(`${SPINNER_FRAMES[1]} Готую`);
      expect(spinnerLoadingLine('Готую', 4)).toBe(`${SPINNER_FRAMES[4]} Готую`);
    });

    it('wraps the frame index modulo the frame count (monotonic counters are fine)', () => {
      const frameCount = SPINNER_FRAMES.length;

      // Index frameCount wraps back to frame 0, frameCount+2 to frame 2.
      expect(spinnerLoadingLine('Cooking', frameCount)).toBe(
        `${SPINNER_FRAMES[0]} Cooking`,
      );
      expect(spinnerLoadingLine('Cooking', frameCount + 2)).toBe(
        `${SPINNER_FRAMES[2]} Cooking`,
      );
    });

    it('animates the SAME word across ticks (only the leading frame changes)', () => {
      const lines = [0, 1, 2, 3].map((frame) =>
        spinnerLoadingLine('Brewing', frame),
      );

      // Every line ends in the same word; only the leading glyph rotates.
      lines.forEach((line) => expect(line.endsWith('Brewing')).toBe(true));
      expect(new Set(lines).size).toBe(4);
    });
  });

  describe('SPINNER_FRAMES', () => {
    it('is the classic 10-frame braille set', () => {
      expect(SPINNER_FRAMES).toEqual([
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
      ]);
    });
  });
});
