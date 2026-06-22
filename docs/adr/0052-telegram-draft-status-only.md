# 0052 — telegram-draft-status-only

- **Status**: Accepted
- **Date**: 2026-06-22
- **Deciders**: @danil

## Context

The Telegram live-status surface (ADR 0012) uses the Bot API `sendMessageDraft`
primitive — an ephemeral ~30 s preview in the chat, animated by re-calling with
the same `draft_id`. On top of it we layered two behaviours:

- **Answer streaming (ADR 0041, Story 13).** The tool loop drives the model with
  `completeStream` and pushes each text snapshot of the final answer into the
  draft, so the user watches the reply being "typed".
- **Empty-text collapse (ADR 0049, FIX 1).** Because the turn ALSO sends the
  answer as a real `sendMessage`, `finalize()` pushed one final
  `sendMessageDraft({ text: '' })` to "retract" the streamed preview and avoid a
  double-show.

In live use this produced a **lingering empty message bubble** after every reply.
A documentation review of the live Bot API (these methods postdate our knowledge
and our original comments were second-hand) established two facts that invalidate
the collapse design:

1. **A draft cannot be promoted into a real message.** The reference is explicit:
   "once the output is finalized, you must call `sendMessage` with the complete
   message to persist it." Both draft methods return `True`, not a `Message`;
   there is no `finalizeDraft`/`commitDraft` and no `final` flag. The separate
   `sendMessage` is the only sanctioned way to persist — and Telegram **replaces
   the preview with the sent message** on its own.
2. **An empty-text draft is NOT a retract.** "Pass an empty text to show a
   'Thinking…' placeholder." So our collapse frame was *painting* a blank
   "Thinking…" shimmer that then sat for its full ~30 s TTL — the empty bubble.

(Sources: Telegram Bot API reference `#sendmessagedraft`; Bot API changelog
9.3/10.0/10.1. Verified 2026-06-22.)

## Decision

> The Telegram draft surface is **status-only**: it shows the cycling loading
> word + dots and the per-round recap, and nothing else. The model's answer is
> **never streamed into the draft**, and `finalize()` performs **no empty-text
> collapse**. The answer lands solely as the real `ReplyPresenter.sendText`
> message, which Telegram renders by replacing the draft preview; any residual
> status frame expires with the draft's ~30 s TTL.

The `TurnStreamSink` port therefore carries only `showRecap`. The loop keeps
driving the model with `completeStream` (not `complete`) purely for its
never-throw resilience — the `onText` handler is a no-op.

## Consequences

- ✅ The lingering empty "Thinking…" bubble is gone — the root cause (misusing
  empty-text drafts as a retract) is removed, not worked around.
- ✅ No double-show risk: the draft never holds the answer, so there is nothing to
  duplicate against the real message.
- ✅ Fully aligned with the documented API contract (separate send persists;
  preview is auto-replaced).
- ✅ Simpler surface: one fewer draft frame per turn, no phase race between a
  streamed answer and the loading loop (`StatusSessionPhase.Streaming` removed).
- ⚠️ We lose the "watch the answer type out" live effect. Accepted — the live
  draft UX was already judged "weird" (cf. ADR 0048 removing the STOP button),
  and a single clean reply reads calmer.
- ⚠️ `completeStream` now streams bytes we discard. Kept deliberately for the
  never-throw reconciliation; revisit only if streaming cost matters.

## Alternatives considered

### Keep streaming the answer into the draft; only fix the collapse

Remove the empty-text collapse but keep `streamAnswer`. Rejected: a residual
answer-preview could still co-exist with the real message until the draft TTL,
and the "typing" effect is exactly the UX already disliked. Status-only is the
calmer, lower-surface-area shape.

### Promote/finalize the draft into the persisted message

The original hope. Rejected because the API does not support it (fact 1 above) —
there is no in-place finalize; a separate `sendMessage` is mandatory.

### Abandon drafts entirely; edit one real message (status → answer)

The non-private degraded path, promoted to default. Viable and even simpler, but
discards the native draft shimmer for the *working* phase, which is the one part
of the draft UX that reads well. Status-only keeps that and removes only the
broken parts.

## References

- Narrows ADR [0041](0041-assistant-native-response-streaming.md) (answer is no
  longer streamed into the draft; `completeStream` retained for resilience only).
- Supersedes the FIX 1 empty-text "draft collapse" of ADR
  [0049](0049-telegram-message-formatting-and-draft-finalize.md) (the Markdown→HTML
  formatting decision in 0049 is unaffected).
- Narrows ADR [0050](0050-assistant-composite-status-message.md) (the composite is
  status + recap only; there is no streamed-answer frame that replaces it).
- ADR [0012](0012-assistant-stateful-messenger-and-draft-streaming.md) — the
  live-status draft surface.
- Telegram Bot API reference — `sendMessageDraft` / `sendRichMessageDraft`:
  https://core.telegram.org/bots/api#sendmessagedraft
- Telegram Bot API changelog (9.3 / 10.0 / 10.1):
  https://core.telegram.org/bots/api-changelog
