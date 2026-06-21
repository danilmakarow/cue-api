# 0051 — assistant-loading-state-localization

- **Status**: Accepted
- **Date**: 2026-06-21
- **Deciders**: assistant team

## Context

The live-status loading words (`status-phrases.ts`: the en/uk/ru vocabularies plus
the "Listening to your beautiful voice" voice line) were selected SOLELY from the
Telegram `language_code` via `resolveStatusLocale(languageCode)`. Telegram's
`language_code` is the user's **client UI language**, not the language they are
*writing in*. A user whose Telegram is set to English but who types (or speaks)
Russian therefore saw **English** loading words — a visible mismatch with their
own message.

We support exactly three locales — `ru`, `uk`, `en` — and everything else must
default to `en`.

Two constraints shaped the design:

- The bot is **not** given the user's phone number by Telegram, so the
  original spec's phone-number/country fallback is **infeasible** and is dropped.
- The status surface is **one idempotent `StatusSession`** keyed by the turn's
  correlation id. A voice turn opens it twice — once **before** STT (the
  "Listening…" line, when no text exists yet) and again **after** STT (the real
  loading loop) — so the locale can be **re-resolved** on the second open and the
  ongoing animation simply switches vocabulary.

There is no language-detection dependency in the repo (no `franc`/`cld`), and the
repo convention is to **vendor a small detector** rather than add one for three
locales.

## Decision

**The user's MESSAGE drives the loading words; `language_code` is only the
fallback.** We resolve the status locale through an explicit chain (in
`status-phrases.ts`, consumed by `StatusAnimatorService.begin`):

**Text turn** (`resolveTextStatusLocale`):
1. Detect the message text's own language (`detectMessageLanguage`, ru/uk/en). If
   conclusive → use it.
2. Else the Telegram `language_code` if it maps to ru/uk/en → use it.
3. Else `en`.

**Voice turn**:
4. **Before STT** (the "Listening…" line + initial loading): `language_code` if
   ru/uk/en, else `en` — no text exists yet (`resolveStatusLocale` on the code).
5. **After STT** (`resolveVoiceStatusLocale`): the STT-reported `result.language`
   if it maps to ru/uk/en → use it; else detect the transcript; else
   `language_code`; else `en`. The same idempotent `StatusSession` is re-opened so
   the live animation switches locale.

The **message-text-priority** for text turns is the deliberate fix: it is what
lets a Russian message show Russian words under an English `language_code`.

The detector (`detect-message-language.ts`) is a vendored, dependency-free
script/marker heuristic restricted to the three locales:
- Ukrainian-distinctive letters (`і ї є ґ`) ⇒ `uk` (conclusive — absent in Russian).
- Russian-distinctive letters (`ы ъ э ё`) ⇒ `ru` (conclusive — absent in Ukrainian).
- Cyrillic with no distinctive marker ⇒ `ru` (the safer default for ambiguous
  shared-core Cyrillic; Russian is the dominant input).
- Predominantly Latin ⇒ `en` (above a small letter-count floor).
- Too little signal (no letters / too short) ⇒ `null`, so the caller falls back.

The STT-reported language — previously **discarded** by `transcribeVoice` (it
returned only `result.text`) — is now surfaced (`{ text, language }`) and threaded
through `BufferedMessage` / `DebounceAnswerPayload` → `TurnRunnerService` →
`StatusAnimationInput.sttLanguage`.

## Consequences

- ✅ A user writing/speaking ru/uk sees ru/uk loading words regardless of their
  Telegram UI language — the reported bug is fixed.
- ✅ Voice turns switch from the pre-STT (`language_code`) locale to the actually
  spoken language once STT returns, on the same surface (no second message).
- ✅ No new dependency; the detector and the resolution chain are pure and fully
  unit-tested.
- ✅ `en` remains the guaranteed default for every unsupported language.
- ⚠️ The detector is a heuristic, not a statistical model. A **short** Ukrainian
  phrase using only shared-core Cyrillic (no `і ї є ґ`) is reported as `ru`; the
  `language_code` fallback mitigates this for users whose client is set to `uk`.
  This only affects the *cosmetic* loading vocabulary, never the model's reply.
- ⚠️ When the STT model returns no language (e.g. OpenAI's `gpt-4o-*-transcribe`),
  the post-STT locale leans on transcript detection — acceptable given the above.

## Alternatives considered

### Keep `language_code`-only selection

The status quo. Rejected: it IS the bug — `language_code` is the client UI
language, not the message language, so it mismatches users who write in a
different language than their app is set to.

### Add a language-detection library (`franc` / `cld`)

More accurate across many languages. Rejected: we support only three locales, a
script/marker heuristic covers them well, and the repo convention is to vendor a
small detector over adding a dependency for this.

### Phone-number / country fallback (original spec)

Use the user's phone-number country as a locale hint. Rejected: **infeasible** —
Telegram does not give the bot the user's phone number, so there is nothing to
key off. Dropped entirely.

### Detect on the transcript only for voice (ignore STT's language)

Simpler (one code path with the text chain). Rejected: the STT model's reported
language is a stronger, cheaper signal than re-detecting a possibly-short
transcript, so it takes priority when present; transcript detection remains the
fallback.

## References

- [ADR 0012 — assistant stateful messenger and draft streaming](0012-assistant-stateful-messenger-and-draft-streaming.md)
- [ADR 0042 — assistant inbound debounce and queue-after](0042-assistant-inbound-debounce-and-queue-after.md)
- [ADR 0050 — assistant composite status message](0050-assistant-composite-status-message.md)
- `src/modules/assistant/reply/detect-message-language.ts`
- `src/modules/assistant/reply/status-phrases.ts`
