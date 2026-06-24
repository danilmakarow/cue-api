# 0053 — telegram-status-message-morph

- **Status**: Accepted
- **Date**: 2026-06-23
- **Deciders**: Danil, assistant

## Context

The live-status surface went through three designs: stream the answer into an
ephemeral Telegram draft (ADR 0041), compose status + recap in that draft (ADR
0050), then status-only-in-draft with the answer as a separate `sendMessage`
(ADR 0052). In live use every draft-based design left the user seeing **two
messages**: the ephemeral draft preview lingered next to the real reply.

Two research passes against the live Bot API + changelog + grammY/aiogram +
MTProto `api/drafts` established the hard constraints (Bot API 9.3–10.1):

- A streaming draft **cannot be promoted** into a persisted message and **cannot
  be deleted** — there is no `clearMessageDraft`/finalize; `sendMessageDraft`
  returns `True`, not a `Message`. It only **self-expires after ~30 s**.
- An **empty-text draft is NOT a retraction** — it renders the native "Thinking…"
  placeholder (which is exactly why the ADR 0052 "collapse" produced a blank
  ghost).
- The canonical pattern (stream one stable `draft_id`, then a separate
  `sendMessage`) is documented, but **nothing documents that the sent message
  atomically clears the live preview** — so a ≤30 s ghost is possible and
  undocumented. The user observed it twice across two designs.

There is therefore no Bot-API lever to guarantee "exactly one message" while a
draft is in play. The dots animation also visually fought Telegram's own native
draft loading indicator.

## Decision

We **abandon Telegram drafts entirely** for the assistant. Each turn posts **one
real message** ("loading line"), edits it in place with per-round recaps, and the
turn's final reply **edits (morphs) that same message** into the answer (or an
`ask_user` question + inline keyboard). The user only ever sees **one message that
changes in place** — no ephemeral draft, no ghost, no dot animation. The vendor's
`sendMessageDraft` primitive is retained in the connector as a dormant faithful
wrapper of the Bot API, but the assistant never calls it.

## Consequences

- ✅ Exactly one message per turn, guaranteed — the ghost is structurally
  impossible (we own a real `message_id` throughout and `editMessageText` it).
- ✅ No dot/word animation fighting Telegram's indicators; the status surface is
  calm (loading line → recaps → answer).
- ✅ Large simplification: the draft throttle, the dot/word `setInterval` pair,
  the composite view-model, the `StatusSurfaceKind` split, and the
  `draft_id` derivation are all deleted. One uniform surface for every chat type.
- ⚠️ We lose Telegram's native draft "shimmer" during generation; liveness now
  comes from a one-shot `typing` chat action + the per-round recaps.
- ⚠️ `editMessageText` is subject to edit flood-control; mitigated because edits
  are low-frequency (one loading line + a recap per tool round + one final morph),
  not per-token — so no throttle is needed.
- ⚠️ A morph that cannot land (message deleted/too old → edit 400s) falls back to
  sending a fresh reply and deleting the stale status message; a brief two-message
  blink is possible only in that rare failure path.

## Alternatives considered

### Keep streaming the answer into the draft (ADRs 0041/0050)

The canonical Bot-API use. Rejected: the user explicitly disliked seeing the
answer "twice", and the lingering preview is undocumented/uncontrollable.

### Status-only draft + empty-text "collapse" (ADR 0052)

Rejected: verified that empty text renders a "Thinking…" placeholder, not a
retraction — it *caused* the blank ghost rather than removing it, and the draft
still cannot be deleted.

### Delete the status message when the answer arrives (send new + `deleteMessage`)

A viable clean end-state, but it shows both messages for a sub-second window
before the delete lands. The morph (edit-in-place) has zero such window, so it
won; delete-stale is retained only as the morph's failure fallback.

## References

- Supersedes [0052](0052-telegram-draft-status-only.md); narrows
  [0041](0041-assistant-native-response-streaming.md),
  [0050](0050-assistant-composite-status-message.md), and the draft surface of
  [0012](0012-assistant-stateful-messenger-and-draft-streaming.md). Leaves the
  Markdown→HTML reply formatting of [0049](0049-telegram-message-formatting-and-draft-finalize.md) intact.
- Verified Bot API facts: `core.telegram.org/bots/api#sendmessagedraft`,
  `core.telegram.org/bots/api-changelog`, `core.telegram.org/api/drafts`,
  grammY `@grammyjs/stream`.
