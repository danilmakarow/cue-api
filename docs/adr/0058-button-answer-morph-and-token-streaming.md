# 0058 — button-answer-morph-and-token-streaming

- **Status**: Accepted (supersedes the "answer is not streamed" clause of [0053](0053-telegram-status-message-morph.md) and re-opens the streaming reversed by [0052](0052-telegram-draft-status-only.md))
- **Date**: 2026-06-24
- **Deciders**: cue-api assistant team

## Context

ADR [0053](0053-telegram-status-message-morph.md) made the turn a SINGLE real
message that is posted as a loading line, edited with per-round recaps, then
edited one last time ("morphed") into the final answer — no ephemeral draft. ADR
[0057](0057-status-spinner-and-code-recaps.md) layered a throttled ASCII spinner
and HTML `<pre>` recaps onto that one message, with a serialized `pendingEdit`
chain drained by `settle()` before the morph, and taught the connector to treat
Telegram's `message is not modified` 400 as success.

Two gaps remained on the `ask_user` flow and the answer surface:

1. **A tapped `ask_user` question stayed live.** After a user tapped an inline
   option, the original question message kept its buttons and gave no sign the
   choice was registered — it could be re-tapped, and the thread read as an
   unanswered question.
2. **The answer never streamed.** ADR 0052 had narrowed the draft surface to
   status-only and ADR 0053's morph delivered the answer in ONE final edit, so
   the user watched a spinner and then saw the whole answer appear at once. A
   resumed `ask_user` turn was worse: it passed NO stream sink, so it showed no
   per-round progress at all mid-flight.

The user opted in to token streaming, accepting the higher edit rate it implies.

## Decision

**Feature 1 — answered-question morph.** On suspend, the orchestrator captures
the question message's vendor id onto the durable `pending_question` row
(`payload.questionVendorMessageId`, jsonb — no migration) via a new
`PendingInteractionService.attachQuestionMessageId` (load → set → save,
short-circuit-if-unchanged, degrade-never-throw). `ReplyPresenter.sendQuestion`'s
fresh-keyboard fallback now returns its `sendActions` message id (was `null`) so
this works on both the morph and fresh-keyboard paths. On the WINNING claim of a
**button** resume, the runner calls a new
`ReplyPresenter.markQuestionAnswered(...)` BEFORE opening the status surface,
which `editMessageText`s the question message to `question + "\n\n<localized
prefix> <label>"` with `clearButtons: true`. The connector maps `clearButtons` to
`reply_markup: { inline_keyboard: [] }` (the Bot-API way to drop an inline
keyboard via an edit). The double-tap loser gets a null claim and is ignored, so
the keyboard is cleared exactly once.

**Feature 2 — resume gets the same live surface.** `resumeAnswer` now passes
`streamSink: this.streamSinkFor(status)` to `toolLoop.run`, matching `handleText`,
so a resumed answer streams + renders per-round recaps onto its morph message.

**Feature 3 — token streaming.** `TurnStreamSink` gains an optional
`onToken(snapshot)`. The tool loop replaces its deliberate no-op `onText` with a
forwarder `(_delta, snapshot) => streamSink?.onToken?.(snapshot)` for ALL rounds
(a tool_use round's streamed text is overwritten by the per-round recap; the
terminal round's streamed text becomes the answer). The runner wraps `onToken` to
call `StatusAnimation.streamAnswer(snapshot)`, which: stops R1's spinner on the
first token, then **throttles** edits to ≤ ~1/sec via a `Date.now()` timestamp
(coalescing intermediate snapshots, latest wins), pushing the snapshot through R1's
serialized `editStatus` chain as HTML-escaped PLAIN text (no `<pre>` wrap). `settle()`
flushes the latest coalesced snapshot before draining, so it reaches the chain
before the final morph. The final FORMATTED answer is still delivered by the L9
reply morph as the last edit on the SAME message, so streaming + morph reconcile.

## Consequences

- ✅ A tapped question reads as a resolved exchange (no re-tappable dangling card).
- ✅ The answer fills in as the model writes — the turn feels alive, not frozen.
- ✅ A resumed `ask_user` turn now shows the same progress as a fresh one.
- ✅ One message, no draft: ADR 0053's core guarantee is preserved — streaming and
  the morph target the same message id.
- ✅ Additive: jsonb field (no migration); `onToken` optional (no-op sinks and
  pre-R3 rows degrade gracefully); old in-flight rows lacking
  `questionVendorMessageId` skip the question morph.
- ⚠️ **Reverses ADR 0053's calm single-edit intent for the answer surface.** The
  answer now edits the message up to ~1/sec while streaming. Mitigated by the
  ≤1/sec coalescing throttle and by the connector treating `message is not
  modified` (400) as success and reading `retry_after` on a 429 (ADR 0057), so
  high-frequency identical edits never throw and flood-control degrades rather
  than blocks.
- ⚠️ The streamed partial answer is plain escaped text (no Markdown→HTML
  formatting) until the final morph reformats it — a brief unstyled flash.

## Alternatives considered

### Keep the answer un-streamed (status quo of ADR 0052/0053)

Simplest and calmest, but the user explicitly asked for streaming and the
spinner-then-whole-answer experience felt unresponsive on longer answers. Lost on
the product call.

### Stream via Telegram native drafts (`sendMessageDraft`)

Rejected — ADR 0053 abandoned drafts (private-chat only, ~30s ghost that cannot be
deleted). Streaming must stay on the one real morph message.

### No throttle (edit per delta)

Rejected — Telegram edit flood-control (429) would trip almost immediately. The
≤1/sec coalescing throttle is the minimum viable cadence.

### A separate streaming surface from the spinner/recap chain

Rejected — two surfaces race. Routing `streamAnswer` through R1's single
`pendingEdit` chain (drained by `settle()`) keeps spinner, recaps, streamed
tokens, and the final morph strictly ordered on one message.

## References

- [0053 — telegram status message morph](0053-telegram-status-message-morph.md)
- [0057 — status spinner and code recaps](0057-status-spinner-and-code-recaps.md)
- [0052 — telegram draft status only](0052-telegram-draft-status-only.md)
- [0041 — assistant native response streaming](0041-assistant-native-response-streaming.md)
- [0010 — ask_user stateful resume](0010-assistant-ask-user-stateful-resume.md)
