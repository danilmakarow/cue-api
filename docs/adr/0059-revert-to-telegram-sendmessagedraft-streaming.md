# 0059 — revert-to-telegram-sendmessagedraft-streaming

- **Status**: Accepted (supersedes [0053](0053-telegram-status-message-morph.md) and [0057](0057-status-spinner-and-code-recaps.md))
- **Date**: 2026-06-24
- **Deciders**: cue-api assistant team

## Context

The live-status surface oscillated between two families of design:

- **Draft family** (ADRs 0012/0041/0050/0052): stream into an ephemeral Telegram
  draft via `sendMessageDraft`, letting Telegram's own client animate the change.
- **Morph family** (ADR 0053): abandon drafts and own **one real message**, posted
  as a loading line, edited with per-round recaps, then `editMessageText`-morphed
  into the answer. ADR 0057 then layered an ASCII braille spinner and an HTML
  `<pre>` code-block rendering onto that one message; ADR 0058 streamed the answer
  token-by-token into the same morph message.

In live use the morph stack accreted moving parts that fought each other: a
spinner `setInterval` that had to be killed before the morph (the "morph race"
contained in three call-sites), a `<pre>` card that read as a code block rather
than status, and a hand-rolled animation that exists only because we walked away
from Telegram's native shimmer. The original reason for abandoning drafts (ADR
0053) was an **undocumented ~30 s ghost** — the ephemeral preview lingering next to
the real reply. Re-reading the live Bot API establishes that the canonical
draft→`sendMessage` handoff is exactly the documented mechanism, and the spinner /
`<pre>` apparatus is strictly more code than letting Telegram animate the text for
us. The morph stack also re-introduced (ADR 0058) the very token-by-token edit
cadence ADR 0053 set out to avoid — at which point an edited real message is doing
a draft's job, worse, on a flood-controlled `editMessageText` budget.

Verified Bot API facts (re-confirmed against the live reference + changelog):

- `sendMessageDraft(chat_id, draft_id, text?, parse_mode?, entities?, message_thread_id?)`
  — introduced Bot API **9.3** (2025-12-31), opened to **all bots in 9.5**
  (2026-03-01). `draft_id` must be a **non-zero integer**; re-calling with the
  **same `draft_id`** makes Telegram **natively animate** the text change
  client-side (there is no "edit draft" variant — re-calling *is* the update).
- The draft is **private-chat only** and carries **no `reply_markup`** — a draft
  cannot hold inline buttons.
- The draft is an **ephemeral ~30 s preview**. There is **no `clear_draft` flag and
  no `clearMessageDraft` method in the Bot API**; the `clear_draft` flag exists only
  in the MTProto *client* API, which bots cannot use. A turn is **finalised by a
  real `sendMessage`** carrying the full answer; the draft then self-expires and
  Telegram replaces the preview with the delivered message.

## Decision

> **Revert the assistant's live-status surface from the "morph one real message"
> model (ADR 0053) back to native Telegram message drafts via `sendMessageDraft`.**

Per-turn surface lifecycle in **private chats**:

1. **Thinking** — a rotating **loading word** is pushed into the draft. Telegram's
   own shimmer animates it; the word rotation doubles as the draft **keepalive**,
   resetting the 30 s TTL through long tool-loops.
2. **Working** — the draft shows the loading word plus a `<blockquote>` containing
   **only the latest recap** (not an accumulated log).
3. **Answering** — the final answer is **streamed token-by-token into the draft**,
   coalesced to ~4 updates/sec by a revived `DraftThrottle`.
4. **Finalise** — a real `sendMessage` delivers the full answer; the draft
   self-expires and Telegram swaps the preview for the persisted message.

**Voice pre-STT** shows a plain localized "listening" line (one of several
variants), rendered as **plain text** — not a `<blockquote>`, not a `<pre>` code
block.

**Non-private chats** (group/supergroup/channel) keep the ADR 0053
`editMessageText` morph path as a documented fallback, since `sendMessageDraft` is
private-only.

**Removed:** the ASCII braille spinner and its `setInterval` tick, the `<pre>`
code-block rendering of the status surface, and the required env var
`ASSISTANT_STATUS_SPINNER_INTERVAL_MS`.

**Added:** `ASSISTANT_STATUS_WORD_INTERVAL_MS` (loading-word rotation / draft
keepalive interval) and `ASSISTANT_DRAFT_UPDATES_PER_SECOND` (draft rate-limit
cap). The `DraftThrottle` coalescing limiter (deleted in commit `e0eaeaf`) is
revived to enforce the cap.

## Consequences

- ✅ Native Telegram shimmer gives **true streaming liveness** without us owning an
  animation timer — the loading-word rotation and token stream are animated
  client-side from same-`draft_id` re-calls.
- ✅ Large code simplification: the spinner `setInterval`, the `<pre>` status
  rendering, and the whole morph race vanish on the common path; the morph fallback
  survives only on the rare **non-private** branch.
- ⚠️ Drafts are **private-chat only** — the group/supergroup/channel fallback to the
  ADR 0053 `editMessageText` morph is retained, so two surfaces (draft + morph) now
  coexist by chat type.
- ⚠️ There is **no API-level clear** for a draft: we rely on Telegram's native
  draft→message replacement plus the 30 s TTL. A brief preview/real-message overlap
  is **theoretically possible** and must be confirmed by live testing — this is the
  exact ghost risk that motivated ADR 0053, accepted here as the documented
  trade-off for native liveness.
- ⚠️ The draft re-call **rate limit is undocumented**; mitigated by the revived
  `DraftThrottle` coalescing to ~4 updates/sec (`ASSISTANT_DRAFT_UPDATES_PER_SECOND`).
- ⚠️ `ASSISTANT_STATUS_WORD_INTERVAL_MS` and `ASSISTANT_DRAFT_UPDATES_PER_SECOND`
  are new env vars; `ASSISTANT_STATUS_SPINNER_INTERVAL_MS` must be removed from every
  environment.

## Alternatives considered

### Keep the ADR 0053 morph + ADR 0057 spinner / `<pre>` stack

The status quo. Rejected: ADR 0058 already re-introduced token-by-token edits onto
a flood-controlled `editMessageText` budget — at which point the morph message is
imitating a draft, less efficiently, with a hand-rolled spinner and a `<pre>` card
fighting Telegram's native indicators. Drafts do the same job with native animation
and far less code.

### Drafts everywhere, no morph fallback

Cleaner conceptually, but `sendMessageDraft` is **private-only** — group chats would
have no live surface at all. The ADR 0053 morph is the only working option there, so
it is retained as the documented non-private fallback.

### Keep the morph but drop the spinner/`<pre>` (revert only ADR 0057)

A partial walk-back. Rejected: it leaves the morph's token-streaming edits on the
`editMessageText` budget and still forgoes the native shimmer. If we are reverting
the animation apparatus, reverting to the native draft surface that makes the
animation free is the coherent end-state.

## References

- Supersedes [0053](0053-telegram-status-message-morph.md) (the morph-one-message
  surface) and [0057](0057-status-spinner-and-code-recaps.md) (the spinner + `<pre>`
  recaps); the ADR 0053 `editMessageText` morph is retained only as the non-private
  fallback. Re-opens the draft surface of
  [0012](0012-assistant-stateful-messenger-and-draft-streaming.md),
  [0041](0041-assistant-native-response-streaming.md),
  [0050](0050-assistant-composite-status-message.md), and
  [0052](0052-telegram-draft-status-only.md) — but, unlike ADR 0052, **streams the
  answer into the draft** (revived `DraftThrottle`) rather than holding the draft
  status-only. Preserves the answered-question morph and the token-stream sink of
  [0058](0058-button-answer-morph-and-token-streaming.md), now driving the draft on
  the private path and the morph message on the non-private path. Leaves the
  Markdown→HTML reply formatting of
  [0049](0049-telegram-message-formatting-and-draft-finalize.md) intact; the recaps
  it renders are localized by
  [0055](0055-last-message-language-and-reply-language.md).
- Verified Bot API facts: `core.telegram.org/bots/api#sendmessagedraft`,
  `core.telegram.org/bots/api-changelog`, `core.telegram.org/api/drafts` (the
  MTProto-only `clear_draft` flag, unavailable to bots).
