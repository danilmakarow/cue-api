# 0057 — status-spinner-and-code-recaps

- **Status**: Accepted
- **Date**: 2026-06-24
- **Deciders**: Danil, assistant

## Context

ADR 0053 abandoned Telegram drafts and made each turn own **one real message**
that is posted as a loading line, edited with per-round recaps, then morphed into
the answer. To avoid fighting Telegram's native draft "shimmer" it deliberately
shipped **no animation at all** — the loading line was a single static word with a
trailing ellipsis (`Thinking…`) and progress came only from a one-shot `typing`
chat action plus the recaps.

In live use the static line reads as **stalled**: between tool rounds (which can
take several seconds) nothing on the surface moves, so the bot looks frozen. With
drafts gone there is no longer a native indicator to fight — the surface is a plain
edited message we fully control — so a small, well-behaved animation is now both
safe and desirable.

Two forces shape the design:

- **Flood-control.** `editMessageText` is rate-limited; a sub-second animation
  (the old ADR 0012 dot/word `setInterval` pair ran at 500 ms) risks 429s.
- **The morph race (ADR 0053).** Any animation timer MUST be dead before the reply
  morphs the answer, or a late frame edits the message back to a loading line after
  the answer landed.

R2 (ADR 0055) already made the per-round recaps **localized**; what was missing was
purely the *rendering* of the status surface.

## Decision

We re-introduce a **single ASCII braille spinner** on the one status message and
render the whole status surface as an **HTML `<pre>` code block**:

- The loading line is `⠋ Thinking` (a rotating braille frame + the localized word),
  **no trailing ellipsis** — the rotating frame replaces the old static dots.
- The spinner is a `setInterval` armed at the end of `startLoading`, ticking at
  `ASSISTANT_STATUS_SPINNER_INTERVAL_MS` (~1000 ms, never sub-second). It animates
  the **one word captured at open** (not a fresh random word per tick) and pushes
  each frame through the existing serialized `pendingEdit` chain.
- The timer is `.unref()`'d (mirroring the user-lock watchdog) so it never holds
  the process open, and is **stopped at the top of `settle()`, `finalize()`, AND
  `showRecap()`** so it is guaranteed dead before the morph.
- The loading line, the voice "Listening…" line, the recaps, and every spinner
  frame are wrapped in `<pre>…</pre>` (via the exported `escapeHtml`) and sent with
  `OutboundFormat.Html`, so the surface is a calm monospace card distinct from the
  final answer.
- The Telegram connector treats a `400 message is not modified` as **success**
  (a repeated identical frame on a stalled turn is benign) and reads
  `parameters.retry_after` on a `429` as a best-effort log without hard-blocking
  the turn (the webhook queue is `attempts:1`).

The final-answer morph (ReplyPresenter) is unaffected — it sets its own HTML and
runs after the spinner is stopped in `settle()`.

## Consequences

- ✅ The surface visibly *lives* between tool rounds — the spinner moves at ~1 Hz —
  without reintroducing a draft.
- ✅ The `<pre>` code block gives the status surface a distinct, calm look and makes
  the morph into the answer (regular HTML) a clear visual transition.
- ✅ The benign `message is not modified` handling means a stalled turn that re-posts
  the same frame text never logs a spurious fault.
- ⚠️ More `editMessageText` traffic than ADR 0053's zero-animation surface. Mitigated
  by the ~1 s floor and the no-op-edit-as-success handling; still far below the
  per-token cadence ADR 0053 rejected.
- ⚠️ Another timer to reason about; the morph race is contained by stopping the
  spinner in **both** `settle()` and `finalize()` (and `showRecap`).
- ⚠️ `ASSISTANT_STATUS_SPINNER_INTERVAL_MS` is a new **required** env var (no default,
  per the env-config contract) — every environment must supply it or boot fails.

## Alternatives considered

### Keep the static `Thinking…` line (ADR 0053)

The simplest surface. Rejected: it reads as frozen during multi-second tool rounds,
which is the exact complaint that motivated this ADR.

### Revive the old dot/word `setInterval` animation (ADR 0012)

Two timers (a 5 s word cycle + a 500 ms dot cycle). Rejected: the 500 ms cadence
invites 429 flood-control, and cycling the *word* every few seconds is noisier than
a single rotating glyph. A single ~1 s spinner on one captured word is calmer and
safer.

### Animate by editing a plain-text line (no `<pre>`)

Rejected: a monospace `<pre>` card visually separates the working surface from the
answer and keeps the braille glyphs aligned; it reuses the existing HTML edit path
(`EditMessage.format`) at no extra cost.

## References

- Builds on [0053](0053-telegram-status-message-morph.md) (one morphing message);
  reuses the Markdown→HTML escaping of
  [0049](0049-telegram-message-formatting-and-draft-finalize.md); the recaps it
  renders are localized by [0055](0055-last-message-language-and-reply-language.md).
- Re-introduces, in a bounded form, the animation that
  [0012](0012-assistant-stateful-messenger-and-draft-streaming.md) had and ADR 0053
  removed.
- Telegram facts: `core.telegram.org/bots/api#editmessagetext` (the
  `message is not modified` error), `core.telegram.org/bots/api#responseparameters`
  (`retry_after`).
