# 0056 — assistant-reply-keyboard-menu

- **Status**: Accepted
- **Date**: 2026-06-24
- **Deciders**: @danil

## Context

[ADR 0045](0045-assistant-reply-keyboard-and-calendar.md) gave the Telegram
assistant two persistent reply-keyboard surfaces — `Main`
(`[Today's schedule] [Next week] [Settings]`) and `Settings`
(`[Disconnect] [Back]`). Feature R4 adds a third surface: a persistent **"Open
Menu"** entry point that opens an account/status card (a tiny "who am I, am I
connected" screen) with `[Settings] [Logout]` + `[Close]`.

Three facts shape the design, all carried over from ADR 0045 and the ADR-0053
morph model:

1. **A reply-keyboard tap arrives as PLAIN TEXT equal to the button label** — it
   is not a callback. So the label is the routing key, and the inbound router
   gates label-routing on the *active surface* (the docked keyboard owning the
   label) to avoid hijacking a user who literally types a label in conversation.
   The new entry point must be reachable from *normal chat* (Main surface), and
   also re-openable while Settings or the Menu itself is docked.
2. **A Telegram bot message cannot be made truly invisible.** The acceptance —
   the menu card stays "out of the conversation history" — can only mean
   *dedup-deleting* the previous menu card when a new one is opened, and never
   touching that message on normal turns. Repeated `Open Menu` taps must not
   pile up stale cards.
3. **There is no per-user lock on the deterministic keyboard path** (it runs
   outside the lock / debounce, like the command path — ADR 0045). So the
   delete-replace of the prior card has no mutual exclusion and must be ordered
   so the worst-case race is harmless.

The morph model ([ADR 0053](0053-telegram-status-message-morph.md)) governs the
*turn's* one live message; the menu card is a separate, deterministic,
no-LLM message that normal turns never edit or delete.

## Decision

We add a third reply-keyboard surface, `Menu`, with a globally-owned `Open Menu`
button and a dedup-deleted account/status card.

- **Layout (`reply/reply-keyboard.layout.ts`).** A new `KeyboardSurface.Menu`,
  new actions (`OpenMenu`, `MenuSettings`, `Logout`, `CloseMenu`), new labels
  (`openMenu`, `logout`; the Menu surface reuses `settings` / `back`), and a
  `MENU_KEYBOARD` (`[Settings] [Logout]` + `[Close]`). `Open Menu` is added to
  `MAIN_KEYBOARD` so it is reachable from normal chat, and — critically — it is
  registered as an **owned label on EVERY surface** in `SURFACE_ACTIONS` (Main,
  Settings, Menu). Because the inbound router gates label-routing on the docked
  surface owning the label, a globally-owned `Open Menu` routes to `OpenMenu`
  regardless of which surface is active; otherwise the gate would treat it as
  plain chat from Settings/Menu.
- **Presenter (`reply/reply-presenter.service.ts`).** `sendTextWithKeyboard` now
  returns `Promise<string | null>` — surfacing the delivered message id (needed
  to dedup-delete the prior card) while keeping the swallow-and-log-never-throw
  contract (null on a swallowed fault). A new public
  `deleteMessageQuietly(...)` wraps the existing private best-effort delete. No
  vendor-connector change (`sendMessageWithKeyboard` + `deleteMessage` already
  exist).
- **Last-menu store (`session/last-menu.store.ts`).** Redis-only, mirroring
  `ActiveKeyboardStore`. Owns `assistant:menu:{userId}` holding the vendor
  message id of the last docked menu card: `record` (overwrite), `take`
  (`GETDEL`), `clear`. **Durable (no TTL)** like the active-keyboard flag,
  because the card lives in the chat indefinitely until reopened — a TTL would
  orphan a still-visible card. Degrade-never-throw.
- **Handler (`commands/keyboard-action.service.ts`).** `openMenu` builds the
  card via `linkingService.getStatus(user.id)` (🟢 `Connected` when linked, 🔴
  `Not connected` otherwise) plus account lines derived from `user.displayName`
  (split first/rest on whitespace — there is no firstName/lastName column) and
  `user.email`; sends it with `MENU_KEYBOARD`, capturing the new id; THEN
  `take`s the prior id and dedup-deletes it **only when present AND different**;
  records the new id; marks `Menu` the active surface. `logout` reuses the
  disconnect path (unlink + clear active surface + remove keyboard) and
  additionally clears the menu id. `MenuSettings`→`openSettings`,
  `CloseMenu`→`goBackToMain`. No LLM, degrade-never-throw, outside the lock.
- **Send-new-FIRST, delete-old-AFTER.** Because there is no lock, the card is
  sent and recorded before the old one is deleted, so a concurrent race leaves
  at most one extra card — never zero.

## Consequences

- ✅ A persistent `Open Menu` is reachable from any docked surface and resolves
  deterministically (no model round-trip, no token cost).
- ✅ The menu card never accumulates: each open dedup-deletes the prior card, and
  normal turns never touch it — the closest a bot can get to "out of history".
- ✅ The new presenter return value is additive: existing callers that ignore it
  still compile, while the menu path now has the id it needs.
- ✅ `Logout` shares the audited disconnect path, so unlink semantics stay in one
  place; the extra menu-id clear keeps a re-link clean.
- ⚠️ `Open Menu` is owned on every surface — a user who literally types "Open
  Menu" while ANY keyboard is docked gets the menu, by design (the same
  reply-keyboard text-equality tradeoff as ADR 0045). With no keyboard docked it
  is plain chat.
- ⚠️ The delete-replace has no lock, so a pathological double-open can momentarily
  show two cards before one is deleted. Acceptable — store-new-before-delete-old
  guarantees the failure mode is "one extra bubble", never a deleted-but-not-
  replaced card.
- ⚠️ 🟢 `Connected` today means only "a Telegram link row exists" — the sole
  health signal available. A richer liveness check is a follow-up.
- ⚠️ First/last name are derived by splitting `displayName` on whitespace; a
  single-word or empty name renders a dash. Dedicated columns are a follow-up.

## Alternatives considered

### Edit one long-lived menu message in place instead of delete-and-resend

Keep a single menu message and `editMessageText` it on each open. Rejected: the
acceptance is that the card stays out of the running history; an edited message
stays where it was first posted and scrolls up out of view, so reopening would
not bring it back to the bottom. Delete-and-resend always lands the fresh card at
the bottom, and the dedup-delete keeps exactly one.

### A TTL on the last-menu id (mirror the last-button store)

`LastButtonStore` uses a short TTL because its line is a one-shot nudge.
Rejected for the menu id: the card it points at lives in the chat until the user
reopens, with no natural expiry. A TTL would let the id lapse while the card is
still visible, so the next open would fail to dedup-delete it and the chat would
accumulate stale cards. Durable (no TTL), cleared explicitly on Logout, matches
the card's lifetime — exactly like the active-keyboard flag.

### Make `Open Menu` owned only by the Main surface

Simpler `SURFACE_ACTIONS`. Rejected: the router gates on the docked surface
owning the label, so a Main-only `Open Menu` would be inert (treated as plain
chat) while Settings or the Menu itself is docked — the button would silently
stop working after the user navigated away from Main. Global ownership is the
minimum needed for the entry point to be reachable everywhere.

### An inline keyboard for the menu card

Inline callbacks would route unambiguously (no text-equality, no active-surface
gate). Rejected for the same reason as ADR 0045: the acceptance is a *persistent*
surface under the input box. The `Open Menu` entry point itself must be a
reply-keyboard button; the card it opens then keeps the persistent menu keyboard
for symmetry with the other surfaces.

## References

- Reply-keyboard infra + the non-hijack active-surface gate: [ADR 0045](0045-assistant-reply-keyboard-and-calendar.md)
- The one-message morph model the menu card sits beside: [ADR 0053](0053-telegram-status-message-morph.md)
- Inbound flow taxonomy (the `keyboard_action` flow): [ADR 0030](0030-assistant-inbound-flow-router-turn-runner.md)
- Telegram link status (`getStatus` / `unlink`): `linking.service.ts`
