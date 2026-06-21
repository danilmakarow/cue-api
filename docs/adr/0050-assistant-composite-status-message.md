# 0050 — assistant-composite-status-message

- **Status**: Accepted
- **Date**: 2026-06-21
- **Deciders**: cue-api maintainers

## Context

The live-status surface (`StatusAnimation`, ADR 0012/0040/0041) drives ONE
ephemeral Telegram draft per turn. Two distinct pieces of information compete for
that single draft:

1. **The status line** — the cycling loading word + the animated trailing dots
   (`Thinking.` → `Thinking..` → `Cooking...`), driven by two `setInterval`s.
2. **The recap** — a one-sentence, present-tense progress note generated between
   tool rounds by `RoundRecapService` ("Checking Thursday afternoon"), the
   "technical details of what the model is doing right now".

Before this ADR the single draft was **last-writer-wins**, so these two clobbered
each other:

- `renderLoadingFrame` pushed `"<word><dots>"`.
- `showRecap` pushed JUST the recap (replacing the draft), then **re-armed** the
  loading timers so the very next tick overwrote the recap with `"<word><dots>"`.

Net effect: the recap flashed for a frame and was immediately erased by the dots;
the user never reliably saw what the model was doing. The draft was also sent with
**no `format`**, so even if a recap had survived it would have rendered as raw
text. (The chunk-1 fix, ADR 0049, added `OutboundFormat.Html` + a
Markdown→Telegram-HTML converter and wired `MessageDraft.format → parse_mode` in
the connector, but `StatusAnimation.pushDraft` never set a format.)

## Decision

The status draft becomes ONE **composite** message built from a per-animation
view-model `{ statusLine; detailBlock? }`:

- **Top**: `statusLine` — the loading word + animated dots. Loading ticks update
  ONLY `statusLine`.
- **Below** (when present): `detailBlock` — the recap, HTML-escaped and wrapped in
  a `<blockquote>`, separated from the status line by a blank line. `showRecap`
  updates ONLY `detailBlock`.

Both writers call a single `renderComposite()` that assembles the one draft body
and pushes it through the existing throttle with `format: OutboundFormat.Html`, so
the connector sets `parse_mode=HTML` and Telegram actually renders the quote.

`showRecap` **no longer re-arms** the loading timers: they are armed once by
`startLoading` and never torn down between rounds, so the dots keep ticking on top
while the recap persists below — each tick re-renders the SAME composite
(`statusLine` updated, `detailBlock` preserved). `streamAnswer` (the final answer)
**replaces** the composite outright (resetting the view-model so no stale recap
leaks) and `finalize` collapses the draft with an empty-text frame (ADR 0049 FIX
1) — both unchanged.

## Consequences

- ✅ The recap and the status animation coexist: the user sees the cycling word on
  top AND the persistent "what it's doing now" quote below, in ONE message — no
  flashing, no clobbering.
- ✅ The recap renders as a real Telegram quote (`<blockquote>`) because the draft
  now carries `format: Html`, closing the last gap left by ADR 0049.
- ✅ The timer model is simpler: one arm point (`startLoading`), no re-arm dance in
  `showRecap`, so the ONE-`setInterval`-pair-per-turn invariant (ADR 0012) is
  easier to reason about.
- ⚠️ Every loading tick now sends the FULL composite (status + quote) rather than a
  bare word. The payload is marginally larger, but the throttle (~2–5/s,
  coalescing) is unchanged, so the vendor call rate is unaffected.
- ⚠️ The recap is HTML-escaped (`< > &`) but NOT otherwise sanitized; the recap is
  a plain model sentence, and a malformed frame is best-effort (the connector keeps
  a plain-text retry, ADR 0049), so a degraded quote can never break the turn.

## Alternatives considered

### Render the recap as a `<pre>` code block

`<pre>` would also survive `parse_mode=HTML`, but it forces a monospace,
code-block look. The recap is prose — a plain present-tense sentence — so a
`<blockquote>` reads correctly and visually separates "the model's note" from the
status word, which is the intent ("technical details" framed as a quote, not as a
code dump). `<pre>` remains the documented fallback if a future recap ever carries
pre-formatted content.

### Two separate messages (status draft + a real recap message)

A real message per recap would persist past the ~30 s draft TTL and pile up
between rounds (one per tool round), spamming the chat, and would lose the
"single live surface" property of the draft. Rejected: the whole point of the
draft is ONE updatable surface.

### Keep last-writer-wins but stop re-arming after a recap

Not re-arming would freeze the draft on the recap line until the next recap/stream
(the dots stop), losing the "alive" feel. The composite keeps both: persistent
recap AND live dots.

## References

- [0012 — assistant-stateful-messenger-and-draft-streaming](0012-assistant-stateful-messenger-and-draft-streaming.md)
- [0040 — assistant-live-status-message](0040-assistant-live-status-message.md)
- [0041 — assistant-native-response-streaming](0041-assistant-native-response-streaming.md)
- [0049 — telegram-message-formatting-and-draft-finalize](0049-telegram-message-formatting-and-draft-finalize.md)
- `src/modules/assistant/reply/status-animator.service.ts` — `CompositeViewModel`, `renderComposite`, `showRecap`, `renderLoadingFrame`, `pushDraft`.
- `src/modules/assistant/reply/markdown-to-telegram-html.ts` — the chunk-1 HTML escaper this mirrors.
