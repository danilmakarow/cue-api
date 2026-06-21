import {
  DEFAULT_STATUS_LOCALE,
  nextLoadingWord,
  resolveStatusLocale,
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
});
