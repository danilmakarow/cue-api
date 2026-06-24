# 0055 — last-message-language-and-reply-language

- **Status**: Accepted
- **Date**: 2026-06-24
- **Deciders**: Danil, assistant

## Context

The assistant already resolves a per-turn loading-status locale (`en` / `uk` /
`ru`) for the cosmetic status surface (ADR 0051): a typed message is detected from
its own text, a voice turn AFTER STT uses the STT-reported language, with the
Telegram `language_code` and finally `en` as fallbacks. Two gaps remained:

1. **The voice PRE-STT "Listening…" line has no language signal.** When the user
   sends a voice note, the surface opens before transcription — there is no text to
   detect and no STT language yet. It fell back to the `language_code`, then bare
   `en`. A Russian-speaking user whose Telegram client reports `en` therefore saw
   an English "Listening to your beautiful voice" line on every voice note, even
   mid-conversation in Russian.

2. **Per-round recaps and the model's reply were not pinned to the user's
   language.** The BACKGROUND recap model was prompted in English-only copy, and
   the main model had no explicit instruction to answer in the user's language.

The fix must NOT disturb the ADR 0004 prompt-cache stability: the cross-user
cached prefix (system prompt + tool defs, breakpoint #1) and the per-user stable
region (breakpoint #2) must stay byte-identical across users and turns — no
per-user or detected-locale token may be injected above breakpoint #2.

## Decision

We track each user's **last-message language** in Redis and use it to fill the
gaps:

- A new per-user, Redis-only **`LastMessageLanguageStore`**
  (`assistant:lastLang:{userId}`) records the resolved {@link StatusLocale} on
  every turn whose language we actually know — a typed message, a free-text
  `ask_user` answer, or a voice turn that transcribed successfully. It is
  **sticky**: overwrite-on-write (`SET EX` WITHOUT `NX`, last-write-wins) and a
  plain `GET` on read (NOT `GETDEL`), so it survives across turns. A long TTL
  (`ASSISTANT_LAST_MESSAGE_LANGUAGE_TTL_SECONDS`, default 7 days) self-cleans a
  quiet user. The record is **fire-and-forget** and degrade-never-throw — it never
  blocks or breaks the `attempts:1` turn.

- The **voice PRE-STT loader** peeks this tracker and passes it as a new optional
  `priorLocale` through `StatusAnimationInput` → `StatusAnimatorService.resolveLocale`
  → the status-phrases resolvers, which now end their chain with the borrowed
  language instead of bare `en`. The chain stays pure: `priorLocale` is a parameter,
  the store is never imported into status-phrases.

- **Recaps** are written in the user's language: the turn runner computes the
  turn's locale once and threads `recapLocale` through `ToolLoopState` →
  `RoundRecapService.recapRound`, which builds `roundRecapSystemPrompt(locale)` —
  the base recap prompt plus "Write the sentence in <Russian|Ukrainian|English>."

- The **main model** gets ONE static, language-agnostic sentence in
  `ASSISTANT_SYSTEM_PROMPT`: "Reply in the same language the user writes in …".
  It is byte-identical across users/turns, so breakpoint #1 stays cacheable; **no
  detected locale is ever injected into the cached prefix.**

## Consequences

- ✅ A follow-up voice note keeps the conversation's language on the "Listening…"
  line instead of snapping to English.
- ✅ Recaps and replies match the user's language without per-user prompt tokens
  above the cache breakpoints — ADR 0004 cache stability is preserved.
- ✅ The tracker is one small Redis store mirroring the `LastButtonStore` pattern;
  no DB entity, no new dependency.
- ⚠️ The borrowed language is best-effort and one turn stale: if a user switches
  language mid-conversation, the very next voice note's PRE-STT line may show the
  prior language for the ~1 s until STT returns and the surface re-resolves to the
  spoken language. Acceptable for a cosmetic surface.
- ⚠️ A button-callback resume does NOT record (the `ask:` callback data is not
  natural language), so a conversation conducted purely via inline buttons never
  updates the tracker — it keeps the last typed/spoken language, which is the
  desired behaviour.
- ⚠️ One more required env var (`ASSISTANT_LAST_MESSAGE_LANGUAGE_TTL_SECONDS`); it
  must be present in `.env`, `.env.example`, the SSM non-secrets, and the env spec
  fixture or the app fails to boot (required-env discipline).

## Alternatives considered

### Inject the detected/borrowed locale into the cached system prefix

Putting "Reply in Russian" above breakpoint #2 would be the most direct nudge, but
it makes the per-user cached region vary by turn and the cross-user prefix vary by
user — breaking the ADR 0004 cache breakpoints and inflating token cost. Rejected
in favour of a single STATIC language-agnostic instruction plus a volatile-tail
option below breakpoint #2.

### Persist the last language on the User row / a DB column

Durable and queryable, but it is cosmetic, ephemeral state with a natural TTL —
exactly what Redis is for. A DB column adds a migration and write amplification on
every turn for no durability benefit. Rejected; mirror the `LastButtonStore` /
active-keyboard Redis precedent instead.

### Read-then-clear (GETDEL) like the last-button nudge

The last-button line is a one-shot nudge consumed by exactly the next turn. The
language tracker must instead persist across turns so a *sequence* of voice notes
all borrow it. Rejected: a plain sticky `GET` is the correct read.

## References

- Builds on the locale-resolution chain of
  [0051](0051-assistant-loading-state-localization.md) and the one-message morph
  surface of [0053](0053-telegram-status-message-morph.md).
- Honours the prompt-cache breakpoints of [0004](0004-assistant-prompt-composition-and-caching.md).
- Mirrors the Redis-only store pattern of the latest-button line
  ([0045](0045-assistant-reply-keyboard-and-calendar.md)).
