# 0049 — telegram-message-formatting-and-draft-finalize

- **Status**: Accepted
- **Date**: 2026-06-21
- **Deciders**: cue-api maintainers

## Context

Three user-visible faults in the Telegram presentation layer were diagnosed in
the live bot:

1. **Markdown renders as raw symbols.** `ReplyPresenter.sendText` sent the
   model's answer with **no `format`**, so the connector's `toParseMode` returned
   `undefined` and Telegram displayed the model's Markdown literally
   (`**bold**`, `` `code` ``, `# heading`). The connector already mapped
   `OutboundFormat.Markdown → MarkdownV2`, but `MarkdownV2` requires escaping a
   wide set of punctuation (`_ * [ ] ( ) ~ ` > # + - = | { } . !`); unescaped
   model output returns HTTP 400 from `sendMessage`, and `callApi` throws →
   `sendText` swallowed it → **the user got NO reply at all**.

2. **Duplicate messages during streaming.** The tool loop streams the full
   answer snapshot into the ephemeral draft (`StatusAnimation.streamAnswer →
   pushDraft`), and the turn then sends the SAME answer as a real `sendMessage`.
   `StatusAnimation.finalize` deliberately did not retract the draft, so the user
   saw the answer twice (the streamed draft preview + the real message), and a
   reopened chat re-animated the orphaned draft until its ~30 s TTL.

3. **Chat scrolls to top / empty screen on send.** `StatusAnimation.open()`
   posted an immediate **empty-text** placeholder draft (Telegram's native
   "Thinking…" shimmer). The Telegram client reserves layout space for the
   streaming-draft surface and scrolls toward it; an empty surface posted before
   any content amplifies the jump.

The bot streams answers via `sendMessageDraft` (an ephemeral ~30 s preview,
animated client-side by re-calling with the same `draft_id`) and finalizes with
a real `sendMessage` (ADR 0012). Drafts are private-chat-only; non-private chats
degrade to a single edited static line.

## Decision

1. **Format model answers as Telegram HTML, not MarkdownV2.** We add
   `OutboundFormat.Html` (mapped to `parse_mode: 'HTML'` in the Telegram
   connector) and a **vendored** Markdown → Telegram-HTML converter
   (`markdown-to-telegram-html.ts`, no new dependency) bounded to Telegram's
   supported tag allowlist (`b, i, u, s, code, pre, a href, blockquote`),
   escaping only `< > &`. `ReplyPresenter.sendText` converts the answer and sends
   it with `OutboundFormat.Html`. Unsupported Markdown degrades to escaped plain
   text — it can never inject a tag Telegram rejects.

2. **Plain-text fallback so a reply is never lost.** If the formatted send
   throws/returns null, `sendText` retries ONCE as **plain text** (no
   `parse_mode`) using the ORIGINAL un-converted text. The user ALWAYS gets the
   answer even if a converted message still 400s.

3. **Collapse the streamed draft on finalize.** `StatusAnimation.finalize` now
   pushes ONE final **empty-text** draft frame (`sendMessageDraft(target,
   {draftId, text: ''})`) BEFORE clearing the StatusSession, only when a draft
   surface is active. It is sent **un-throttled** (a direct connector call, not
   via the throttle `finalize` just cancelled) so the retraction is not coalesced
   away. The real message has already landed (`finishTurn` runs before the
   `finally` that calls `finalize` — see `turn-runner.service.ts`), so the user
   ends with exactly one message. Live token-streaming into the draft is
   unchanged; only the end-of-turn frame collapses.

4. **No empty placeholder draft on open (scroll mitigation).**
   `StatusAnimation.open()` no longer posts the empty-text placeholder draft for
   a private chat. The first draft frame is deferred to `startLoading`, which
   already renders a real first loading word, so the reserved streaming-draft
   surface only appears once it carries content.

## Consequences

- ✅ The model's Markdown renders as formatted text (bold/italic/code/links/
  lists/headings/quotes) instead of raw symbols.
- ✅ A malformed-HTML 400 (or a blocked bot) no longer silently drops the reply —
  the plain-text retry guarantees delivery.
- ✅ HTML is far harder to malform than MarkdownV2 (only `< > &` need escaping),
  so the formatted path succeeds in the overwhelming majority of cases and the
  fallback is rarely exercised.
- ✅ No duplicate answer after a streamed turn; no re-animating orphan draft on
  chat reopen.
- ⚠️ The scroll/empty-screen fix is a **partial mitigation only.** The jump is
  ultimately a *client-rendered* draft-surface behaviour (the Telegram app
  reserves space and scrolls for the streaming-draft surface); removing the empty
  placeholder reduces, but does not fully eliminate, the effect. A complete fix
  would require either dropping draft streaming or a Telegram client change —
  both out of scope here.
- ⚠️ The converter is a focused, best-effort parser, not a full CommonMark
  implementation — nested/edge Markdown degrades to escaped plain text by design.
  Acceptable because the plain-text fallback backstops any send that still fails.
- ⚠️ The ASCII-calendar path (`keyboard-action.service` →
  `sendTextWithKeyboard`, `OutboundFormat.Markdown`) is intentionally left on
  MarkdownV2 — its content is a controlled monospace code block, not free-form
  model output, so it is unaffected.

## Alternatives considered

### Escape the model output for MarkdownV2 and keep `OutboundFormat.Markdown`

Rejected. MarkdownV2 escaping is broad and context-sensitive (the same character
must be escaped or not depending on whether it is inside a code span, a link, an
entity, etc.). A single miss 400s the whole send. HTML's escape set is just
`< > &`, making correct output dramatically easier to guarantee.

### Send the raw model Markdown with `parse_mode: 'Markdown'` (legacy v1)

Rejected. Legacy Markdown is deprecated by Telegram, cannot express the full
formatting set, and still 400s on unbalanced delimiters — no safer than v2.

### Delete the draft on finalize instead of collapsing it to empty text

Rejected. A draft has no stable deletable message id (re-calling with the same
`draftId` IS the only update mechanism; there is no "delete draft"). Pushing one
empty-text frame is the supported retraction and animates cleanly to nothing.

### Stop streaming the answer into the draft entirely (kills the duplicate at the source)

Rejected. Users like the live streaming preview. Collapsing only the final frame
preserves the streaming UX while removing the lingering duplicate.

## References

- [0012 — assistant-stateful-messenger-and-draft-streaming](0012-assistant-stateful-messenger-and-draft-streaming.md)
- [0041 — assistant-native-response-streaming](0041-assistant-native-response-streaming.md)
- `src/modules/assistant/reply/markdown-to-telegram-html.ts`
- `src/modules/assistant/reply/reply-presenter.service.ts`
- `src/modules/assistant/reply/status-animator.service.ts`
- `src/modules/external-vendor/telegram/telegram-vendor.connector.ts`
