import { detectMessageLanguage } from './detect-message-language';

describe('detectMessageLanguage (v2 Task 4 / ADR 0051)', () => {
  describe('clear Russian', () => {
    it('detects Cyrillic-without-distinctive-markers as ru (the safer default)', () => {
      // Pure shared-Cyrillic core, no ы/ъ/э/ё and no і/ї/є/ґ → ru.
      expect(detectMessageLanguage('перенеси встречу на завтра')).toBe('ru');
    });

    it('detects Russian-distinctive letters (ы ъ э ё) as ru', () => {
      expect(detectMessageLanguage('сегодня был тяжёлый день')).toBe('ru'); // ё
      expect(detectMessageLanguage('какие планы')).toBe('ru'); // shared core → ru default
      expect(detectMessageLanguage('это мой объём работы на сегодня')).toBe(
        'ru',
      ); // э, ъ, ё
    });
  });

  describe('clear Ukrainian (via і / ї / є / ґ)', () => {
    it('detects the Ukrainian-distinctive і as uk', () => {
      expect(detectMessageLanguage('перенеси зустріч на завтра')).toBe('uk');
    });

    it('detects ї / є / ґ as uk', () => {
      expect(detectMessageLanguage('моє завдання на сьогодні')).toBe('uk'); // є
      expect(detectMessageLanguage('Україна та її люди')).toBe('uk'); // ї
      expect(detectMessageLanguage('ґанок біля хати')).toBe('uk'); // ґ + і
    });

    it('a single distinctive Ukrainian marker is conclusive even in a short string', () => {
      expect(detectMessageLanguage('ні')).toBe('uk'); // і
    });
  });

  describe('clear English', () => {
    it('detects Latin text as en', () => {
      expect(detectMessageLanguage('move my meeting to tomorrow')).toBe('en');
      expect(detectMessageLanguage('what is on my calendar today')).toBe('en');
    });
  });

  describe('inconclusive → null (caller falls back to language_code)', () => {
    it('returns null for empty / whitespace / undefined', () => {
      expect(detectMessageLanguage(undefined)).toBeNull();
      expect(detectMessageLanguage('')).toBeNull();
      expect(detectMessageLanguage('   ')).toBeNull();
    });

    it('returns null for digits / punctuation / emoji only (no letters)', () => {
      expect(detectMessageLanguage('123 456')).toBeNull();
      expect(detectMessageLanguage('?!.. ,,')).toBeNull();
      expect(detectMessageLanguage('👍🔥🎉')).toBeNull();
      expect(detectMessageLanguage('15:30 — 16:00')).toBeNull();
    });

    it('returns null for a too-short Latin fragment (below the confidence floor)', () => {
      // A single Latin letter is not enough signal to claim en.
      expect(detectMessageLanguage('a')).toBeNull();
      expect(detectMessageLanguage('x!')).toBeNull();
    });

    it('is conclusive for two or more Latin letters', () => {
      expect(detectMessageLanguage('ok')).toBe('en');
    });
  });

  describe('mixed text robustness', () => {
    it('weighs by the dominant script — Cyrillic-dominant mixed text → ru', () => {
      // A stray Latin word does not flip a Russian sentence to en.
      expect(detectMessageLanguage('запланируй meeting на 5 вечера')).toBe(
        'ru',
      );
    });

    it('weighs by the dominant script — Latin-dominant mixed text → en', () => {
      // A stray Cyrillic word does not flip an English sentence away from en.
      expect(detectMessageLanguage('book a table at кафе for two')).toBe('en');
    });

    it('a Ukrainian marker wins inside otherwise-shared Cyrillic', () => {
      // The і makes it uk even though the rest is shared-core Cyrillic.
      expect(
        detectMessageLanguage('зустрінемось завтра о пів на сьому, і все'),
      ).toBe('uk');
    });

    it('ignores emojis / punctuation around real letters', () => {
      expect(detectMessageLanguage('привет 👋, как дела?')).toBe('ru');
      expect(detectMessageLanguage('hi 👋, how are you?')).toBe('en');
    });
  });
});
