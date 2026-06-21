# 0045 — assistant-reply-keyboard-and-calendar

- **Status**: Accepted
- **Date**: 2026-06-21
- **Deciders**: @danil

## Context

v2 Story 16 adds keyboard-driven navigation to the Telegram assistant on top of
the Story-10 messenger primitives ([ADR 0038](0038-assistant-messenger-primitives-status-session.md)).
The user-facing acceptance: a persistent reply keyboard `[Today's schedule]
[Next week] [Settings]`; `Settings` swaps to `[Disconnect] [Back]`; the two
schedule buttons render a monospace ASCII calendar from
`TaskService.findOccurrencesInRange` in the user's timezone; `Disconnect`
unlinks the chat.

Two facts shape the design, both verified ([ADR 0012](0012-assistant-stateful-messenger-and-draft-streaming.md), `specs/ai-workflow-v2-plan.md` Story 10/16):

1. **A reply-keyboard tap arrives as PLAIN TEXT equal to the button label** — it
   is NOT an inline-keyboard callback. So the label *is* the routing key, and a
   user who literally types "Settings" in normal conversation produces a wire
   message indistinguishable from a tap. Routing on text-equality alone would
   hijack ordinary conversation.
2. **The prompt's cached prefix must stay byte-stable** ([ADR 0004](0004-assistant-prompt-composition-and-caching.md)).
   The model should learn what the user just did via a button, but injecting that
   line into the cached system/profile/summary region would defeat the prefix
   cache on every tap.

The deterministic, no-LLM inbound paths already exist (command, STOP-control —
[ADR 0030](0030-assistant-inbound-flow-router-turn-runner.md), [ADR 0043](0043-assistant-stop-cooperative-cancellation.md));
a keyboard tap is a third such path and must join the same divergence gate.

## Decision

We add reply-keyboard navigation as a fourth deterministic inbound flow, gated on
an active-surface flag, with the latest-button outcome injected into the prompt's
volatile tail only.

- **Layout is single-sourced** (`reply/reply-keyboard.layout.ts`): the two
  surfaces (`Main`, `Settings`), their labels, and a per-surface `label→action`
  table. `resolveKeyboardAction(surface, label)` returns an action only when the
  *docked* surface owns that exact label.
- **Routing = text-equality AND active surface.** The L2 inbound router
  (`classifyFlow`) treats a typed-text message equal to a label as a
  `keyboard_action` flow **only when** `ActiveKeyboardStore.getActiveSurface(userId)`
  returns a surface that owns the label. With no active keyboard (or a different
  one docked, or a voice transcript) the same text is an ordinary
  `simple_message`. This two-part gate is the non-hijack guarantee. The active
  surface is a per-user Redis flag (`assistant:keyboard:{userId}`), set on every
  dock/swap and cleared on Disconnect.
- **Deterministic handler** (`commands/keyboard-action.service.ts`): renders the
  ASCII calendar (a direct `ScheduleReaderService` read → `renderAsciiCalendar`,
  NO LLM), swaps the docked surface, or disconnects (`LinkingService.unlink` +
  `ReplyKeyboardRemove`). It runs OUTSIDE the per-user lock / debounce buffer
  (like the command and STOP paths) because it commits no calendar write.
- **ASCII calendar** (`reply/ascii-calendar.ts`): deterministic, every line
  bounded to ~30 chars for mobile width (titles ellipsis-truncated), iterated by
  LOCAL calendar day so empty days read as free, sent inside a Markdown code
  block so the monospace columns align.
- **Latest-button context → volatile tail only.** After each action the handler
  overwrites `assistant:lastButton:{userId}` (`LastButtonStore.record`). On the
  NEXT model turn the context builder reads-and-clears it (`GETDEL`) and appends
  one line to the final user content — alongside the now-context, **below both
  cache breakpoints**. The system/profile/groups/summary blocks stay byte-stable,
  preserving the ADR-0004 prefix cache.
- **The keyboard is docked at the (re)engagement entry points** — `/start` and
  `/link` for an already-linked user — via `KeyboardActionService.showMainKeyboard`,
  which both sends the keyboard and sets the active surface.
- **Degrade-never-throw.** Every new Redis read/write and keyboard send swallows
  its fault (logged at debug). A Redis blip on the active-surface read returns
  "no active surface" (the safe default — a label is then plain conversation,
  never a wrong destructive action); a last-button fault simply omits one line of
  the next turn's context. The inbound path is `attempts:1`, so no new call may
  break a turn.

## Consequences

- ✅ A reply-keyboard tap is resolved deterministically and instantly (no model
  round-trip, no token cost) for the four navigation actions.
- ✅ A user who types a label in conversation is never hijacked — the active
  surface plus per-surface label ownership is the precise disambiguator, proven
  by unit tests (`ingress/inbound-router.spec.ts`: "does NOT hijack a
  literally-typed 'Settings' when NO keyboard is the active surface", "does NOT
  route a label the DOCKED surface does not own").
- ✅ The latest-button nudge keeps the model aware of menu-driven actions without
  touching the cached prefix — `context-builder.service.spec.ts` asserts
  `promptB.system` is byte-identical to `promptA.system` (incl. every
  `cacheBoundary` flag) whether or not a button line is pending, so ADR 0004 cache
  hits survive.
- ✅ A Redis fault on any new call degrades to the safe default and never breaks a
  turn (degrade-never-throw, with unit coverage on the schedule-read failure path).
- ⚠️ The keyboard is only docked on `/start` / `/link`; a user who never sends one
  sees no keyboard. Acceptable — those are the canonical entry points, and the
  app-initiated `redeemNonce` link instructs the user to send `/start`.
- ⚠️ Text-equality routing means a label string that collides with a literal the
  user might tap-then-mean-differently is inherently ambiguous; the active-surface
  gate is the mitigation, but a user who taps `Today's schedule` *intending* a
  free-text turn still gets the deterministic calendar. This matches every
  messenger's reply-keyboard semantics and is the expected behaviour.
- ⚠️ The active-surface flag is durable (no TTL) and only cleared on Disconnect; a
  stale flag is harmless because an unlinked chat re-enters the linking handshake
  before any turn runs.

## Alternatives considered

### Inline keyboard (callback buttons) instead of a reply keyboard

Inline buttons carry `callback_data`, so routing would be unambiguous (no
text-equality, no active-surface flag). Rejected: inline keyboards attach to a
specific message and scroll away with history; the acceptance is a *persistent*
docked surface that stays under the input box across the whole conversation —
that is exactly what a reply keyboard (`is_persistent`) provides and an inline
keyboard cannot.

### Route taps purely on text-equality (no active-surface flag)

Simpler — one label set, one map. Rejected: it hijacks a user who literally types
"Settings"/"Next week" in conversation, turning ordinary text into a
deterministic action and starving the model of the turn. The active-surface flag
is the minimum state needed to tell a tap from a typed sentence.

### Inject the latest-button line into the cached system/profile region

Would put the recent-action context "near the top" with the rest of the user
state. Rejected outright by [ADR 0004](0004-assistant-prompt-composition-and-caching.md):
any per-turn token above breakpoint #2 invalidates the prefix cache every turn.
The line is per-turn and volatile, so it belongs in the tail with the
now-context.

### Render the calendar via the model (LLM-formatted schedule)

Rejected: the schedule is structured data the app already owns; an LLM render is
non-deterministic, costs tokens, and adds latency for a button that should feel
instant. A pure function over `findOccurrencesInRange` is deterministic, free,
and testable.

## References

- Story 16 row + Telegram reply-keyboard facts: [specs/ai-workflow-v2-plan.md](../specs/ai-workflow-v2-plan.md)
- Cache stability (the volatile-tail constraint): [ADR 0004](0004-assistant-prompt-composition-and-caching.md)
- Messenger primitives (the persistent-keyboard + `sendMessageWithKeyboard` port): [ADR 0038](0038-assistant-messenger-primitives-status-session.md)
- Inbound flow taxonomy (the divergence gate this flow joins): [ADR 0030](0030-assistant-inbound-flow-router-turn-runner.md)
- Schedule reads (`findOccurrencesInRange`): [specs/recurrence-expansion.md](../specs/recurrence-expansion.md)
