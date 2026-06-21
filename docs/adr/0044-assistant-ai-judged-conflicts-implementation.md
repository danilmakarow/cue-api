# 0044 — assistant-ai-judged-conflicts-implementation

- **Status**: Accepted
- **Date**: 2026-06-21
- **Deciders**: @danil

## Context

[ADR 0011](0011-assistant-ai-judged-conflicts.md) (Accepted) decided to replace the
ADR-0006 layer-4 **deterministic conflict hold** with **AI-judged conflicts** under a
strict default-deny posture, and named the guardrails that make handing a deterministic
safety gate to model judgement acceptable: default-deny stated in **both** the system
prompt and every conflict tool-result, a **user-set-only** durable standing flag, and a
**destructive replace always asks** rule. This ADR records how that mechanism was actually
built (v2 Story 15, the safety-critical story), and is the merge gate for it.

The structural swap (chunk 1) already landed: the Redis hold / `confirm:`/`cancel:`
inline keyboard / held-batch executor were deleted; the dispatcher now returns an
overlapping write as a recoverable `isError` tool result restating the clash, the write
tools carry a `confirmOverlap` override, and `TaskService.findOverlapping` /
`findRecurringSeriesConflicts` / `findRecurringEditConflicts` are kept as the
conflict-description source. This ADR covers chunk 2: the **other half of the merge gate**
(the prompt default-deny rule), the **standing `conflict_policy` fact**, and the
**destructive-replace** enforcement — plus the held-test replacement.

## Decision

We complete AI-judged conflicts as follows.

**1. System-prompt default-deny (the prompt half of the gate).** The assistant system
prompt (`assistant.prompts.ts`, `ASSISTANT_SYSTEM_PROMPT`) replaces the stale "the system
will ask you to confirm" Safety block with a firm default-deny rule. Exact wording:

> Safety — conflicts (read this twice)
> - NEVER book or move an event over an existing commitment unless the user explicitly authorized THIS booking in their message, or they have a standing conflict policy that allows it (shown to you in context). Otherwise you MUST call ask_user and let them decide. An overlap is never yours to wave through.
> - When you issue an overlapping write without authorization, the system refuses it and returns an error restating the clash. Do NOT retry blindly: ask the user, and only retry with confirmOverlap:true once they have explicitly said to book over it. A standing "allow" policy is the only thing that lets you set confirmOverlap without asking; a standing "deny" policy means you refuse and do not even ask.
> - A single message is in-message authorization, not a standing policy. Never treat one "yes" as a permanent rule.
> - Deleting or overwriting an existing commitment is destructive and irreversible: ALWAYS ask the user first and proceed only once they confirm — even if they previously authorized an overlap or have a standing allow policy. confirmOverlap never authorizes a delete.
> - Be especially careful with deletes; confirm the referent if there is any ambiguity.

**2. Tool-result default-deny (the wire half of the gate), unchanged from chunk 1.** Every
one-off overlap tool-result ends with the exact `DEFAULT_DENY_INSTRUCTION`:

> Do NOT book over it unless the user explicitly authorized this. If they did, retry this same call with confirmOverlap:true; otherwise call ask_user to get their decision first.

The two statements coexisting — prompt rule + per-result restatement — **is** the merge gate.

**3. `confirmOverlap` override (chunk 1).** A write tool sets `confirmOverlap:true` only when
the user authorized THIS booking in their message; the dispatcher then skips the conflict
check entirely and the write commits.

The gate covers EVERY timed write that can land on an existing commitment: a one-off
create/move, a `this_and_following` / `all` recurring series edit (Story 9), AND a
`this`-scope recurring occurrence MOVE. The last was originally ungated — a "move just this
one occurrence to 10am" applied the override directly, bypassing the conflict check, ignoring
`confirmOverlap`, and (most seriously) double-booking even a standing-DENY user. It is now
routed through the SAME default-deny gate as the one-off move: the dispatcher resolves the
effective post-move occurrence window (the new start, plus the override end or the carried
series duration), excludes the series' own anchor, and on an unauthorized overlap returns the
recoverable `isError` (the deny restatement under DENY, the plain conflict otherwise) instead
of overriding. A standing DENY overrides an in-message `confirmOverlap` here exactly as on the
other paths. A pure rename / completion / notes-only override (no `startAt`/`endAt` change) is
NOT a move and is never conflict-checked. The `this`-scope DELETE/skip path is gated
separately behind `confirmDelete` (point 5).

**4. Standing `conflict_policy` as a durable, EXPLICIT `UserMemoryFact`.** A new
`UserMemoryFactType.CONFLICT_POLICY` (additive enum value + migration
`1782900000000-add-conflict-policy-fact-type.ts`, `ALTER TYPE … ADD VALUE IF NOT EXISTS`,
forward-only no-op `down`). Its `value` is `{ policy: ConflictPolicy }` where
`ConflictPolicy ∈ { allow, ask, deny }`, stored under the single natural key
`conflict_policy/default`.

- **Set via** `UserMemoryFactDatabaseService.setConflictPolicy(userId, policy)` — an
  explicit settings action (the iOS settings screen / an explicit user command), persisting
  `source: EXPLICIT, confidence: 1`. **Never** the memory extractor: the extractor's Zod
  schema refuses the `conflict_policy` type and `MEMORY_EXTRACTION_SYSTEM_PROMPT` forbids it,
  so a policy can never be inferred from a single message.
- **Surfaced** by `ContextBuilderService`: it resolves the policy via
  `findConflictPolicy(userId)` (which returns the disposition only for an EXPLICIT fact, else
  null), renders a firm one-line directive into the volatile L6 now-context (ALLOW / DENY /
  ASK), and returns it on `BuiltPrompt.conflictPolicy`. The tool loop threads that onto
  `ToolDispatchContext.conflictPolicy`, so the model's judgement and the dispatcher's gate
  share one source of truth.
- **Semantics** in the dispatcher gate (`isOverlapAuthorized` / `isOverlapDenied`):
  `ALLOW` ⇒ the overlap check is skipped (proceed WITHOUT asking, as if `confirmOverlap`);
  `DENY` ⇒ the check runs even when `confirmOverlap` is set and the clash is refused with a
  deny-specific restatement (the deny **overrides** an in-message `confirmOverlap`); absent /
  `ASK` ⇒ pure default-deny. `findConflictPolicy` returns null for an unrecognized stored
  value, so a malformed row fails closed (no widening).

**5. Destructive-replace always asks.** A delete removes an existing commitment, so
`delete_task` carries an explicit `confirmDelete` flag and `handleDeleteTask` gates EVERY
destructive path behind it: the recurring-scope question still fires first (the model must
pin the extent before confirming), then an absent `confirmDelete` refuses with a recoverable
"ask the user first" (`ASK_BEFORE_DELETE_RESULT`) instead of deleting. Neither
`confirmOverlap` nor a standing `ALLOW` policy satisfies `confirmDelete` — a destructive
replace always asks, even under an allow policy.

## Consequences

- ✅ The merge gate is met: default-deny is stated in both the system prompt and every
  conflict tool-result, and the dispatcher's recoverable-`isError` restatement is the wire
  mechanism. A power user can opt out once (`allow`) or harden (`deny`) via a durable
  EXPLICIT fact, honoured without a round-trip.
- ✅ Defence in depth: the model is steered (prompt + per-result + policy line), and the
  dispatcher independently enforces the gate (the `ALLOW`/`DENY` decision is computed in
  code off the policy on the context, not trusted to the model's narration).
- ✅ Destructive deletes can never be silently performed by an overlap authorization — a
  separate `confirmDelete` flag is required and cannot be satisfied by `confirmOverlap` or
  an allow policy.
- ⚠️ A deterministic safety gate is now model judgement. Mitigations as in ADR 0011, plus:
  the standing flag is EXPLICIT-only (extractor cannot emit it; an inferred row is ignored),
  the deny policy overrides `confirmOverlap`, and the dispatcher fails closed on a malformed
  policy value.
- ⚠️ A `deny` policy short-circuits before asking — the user's standing answer is "no", so
  the model offers an alternative rather than re-asking. This is intentional but means a deny
  user must change the setting to ever double-book.
- ⚠️ The `conflict_policy` set path is wired in the DB service + surfaced everywhere, but no
  HTTP/iOS settings endpoint exists yet (no controllers in this scaffold). The mechanism and
  e2e seam (`harness.setConflictPolicy`) are proven; the settings UI is a follow-up.

### Held-test replacement (the merge gate's test side)

The stale deterministic-hold e2e (`assistant-pipeline.e2e-spec.ts` "holds an overlapping
create and asks via inline keyboard") is **replaced** by five AI-judged-conflict e2e cases
(CASE 1 core no-double-book → refuse + ask_user, no write; CASE 2 confirmOverlap lands the
write; CASE 4 delete without confirmDelete asks first, no delete; CASE 5 allow-policy commits
without asking; CASE 5 deny-policy refuses even with confirmOverlap). The dead
`harness.heldConflictKeys()` helper is removed. The dispatcher unit suite adds the
allow/deny-policy and destructive-replace cases, plus the `this`-scope occurrence-move gate
cases (core no-double-book refusal, confirmOverlap proceed, DENY-overrides-confirmOverlap,
pure-rename-not-gated) — 74 dispatcher tests — and the context-builder suite asserts the policy
line + `BuiltPrompt.conflictPolicy`.

## Alternatives considered

### Reuse `confirmOverlap` for deletes too

Rejected — a destructive replace is categorically different from booking over a still-present
event. Folding it into `confirmOverlap` would let an overlap authorization (or an allow
policy) silently delete data. A separate, never-implied `confirmDelete` keeps "irreversible"
behind its own explicit confirmation.

### Let the memory extractor infer a conflict policy

Rejected — double-booking is safety-relevant and the extractor is too noisy to be trusted to
infer a standing authorization. Only an EXPLICIT user-set fact counts; the extractor schema
and prompt both refuse the type.

### A boolean "allow overlaps" flag instead of a 3-value policy

Rejected — a boolean cannot express the firmer "never, do not even ask" (`deny`) disposition,
which must override an in-message `confirmOverlap`. The three-value `allow / ask / deny`
captures the full standing intent.

### Trust the model alone (prompt only, no dispatcher enforcement)

Rejected — a prompt regression could silently double-book. The dispatcher independently
enforces the gate off the policy threaded on the context; the prompt steers, the code decides.

## References

- Realizes: [ADR 0011](0011-assistant-ai-judged-conflicts.md) (the accepted mechanism). No
  divergence from 0011 — every guardrail it named is implemented; this ADR adds the concrete
  flag names (`confirmOverlap`, `confirmDelete`), the policy shape (`ConflictPolicy`), and the
  EXPLICIT-only fact key (`conflict_policy/default`).
- Supersedes (via 0011): [ADR 0006](0006-assistant-schedule-context-and-conflicts.md) layer 4.
- Relies on: [ADR 0010](0010-assistant-ask-user-stateful-resume.md) (`ask_user` durable
  suspend/resume), [ADR 0005](0005-assistant-conversation-memory-model.md) (the
  `UserMemoryFact` tier-3 profile), [ADR 0009](0009-assistant-narration-redrive.md)
  (terminal-turn re-drive).
- Plan + acceptance criteria (Corrected Assumption 2, safety-critical):
  [ai-workflow-v2-plan](../specs/ai-workflow-v2-plan.md) Story 15.
