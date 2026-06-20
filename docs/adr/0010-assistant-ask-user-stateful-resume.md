# 0010 — assistant-ask-user-stateful-resume

- **Status**: Accepted
- **Date**: 2026-06-19
- **Deciders**: @danil

## Context

To feel like a person, the assistant should ask a question with **tappable options or a free-text answer**, pause, and then **continue the same task** when the user replies. The assistant runs on an asynchronous Telegram pipeline (webhook → BullMQ job → reply; [specs/ai-workflow.md](../specs/ai-workflow.md)) — there is **no live in-process loop** to pause the way an interactive CLI can. So a question must **end the turn**, and the answer arrives on a **later webhook** (possibly hours later, possibly after a process restart), at which point the turn must be **rebuilt and resumed**, re-invoking the model.

This differs fundamentally from the [ADR 0006](0006-assistant-schedule-context-and-conflicts.md) conflict hold, which resumes **deterministically with no model call**. An `ask_user` answer must be fed back to the model so it can continue its reasoning. The two suspend/resume paths must not be conflated.

## Decision

The model calls an `ask_user` tool (`{ question, options?: {id,label}[].max(4) }` — options optional; omit for a plain text-only question). This **suspends** the turn. The in-flight session — the accumulated `toolRounds` (including the assistant round carrying the `ask_user` `tool_use`, **but not** its `tool_result`), the `askToolUseId`, and the option→label map — is persisted **durably to Postgres** (a `pending_question` row, the system of record) and mirrored to **Redis with a 30-minute TTL** (the hot index). On the user's answer it is fed back as the `ask_user` `tool_result` and the loop is **re-entered**, re-invoking the model (which may suspend again).

- **Claim is atomic and idempotent**: `Redis GETDEL` (hot) **or** `UPDATE pending_question SET status='ANSWERED' WHERE id=? AND status='AWAITING' RETURNING *` (durable) — zero rows ⇒ already resumed ⇒ ignore.
- **Late reply after the TTL**: a **button** carries the row id (`ask:<id>:<opt>`) and resumes from Postgres anytime, up to a hard retention (`ASSISTANT_ASK_USER_RETENTION_HOURS`, default 168). **Free-text** is interpreted as the answer only inside the 30-minute hot window; after it lapses a typed message starts a fresh turn (never silently consumed as a stale answer).
- **Wire invariant**: exactly one synthetic `tool_result` is appended on resume, matching the `tool_use` already in the cached rounds — never an interleaved/unpaired block (Anthropic 400).
- **Held conflicts stay Redis-only** (ephemeral): a stale overlap must expire, not resurrect — the calendar may have moved.

## Consequences

- ✅ Structured quick-replies + seamless continuation make the assistant feel human; the in-flight task context is preserved precisely (not reconstructed from history).
- ✅ Survives the 30-minute TTL **and** a process restart via Postgres — a button answer resumes days later.
- ✅ Distinct keyspace (`assistant:ask:*` vs `assistant:held:*`), callback prefix (`ask:` vs `confirm:`), and resolver from the conflict path — non-conflatable by construction.
- ⚠️ A new `pending_question` entity (+ repository + DatabaseService + migration) and a `@nestjs/schedule` cleanup job.
- ⚠️ Free-text late-resume is **deliberately unsupported** (ambiguity: a message days later may be unrelated) — a button is the durable answer carrier.
- ⚠️ Two inbound updates while a question is pending race; the compare-and-set blocks double-resume, but a per-user advisory lock (deferred) would close the window fully.

## Alternatives considered

### Stateless re-ask (buttons end the turn; the answer is a fresh turn from DB history)

Simpler — no cached session. Rejected: it loses the in-flight `toolRounds` (the model re-reads/reconstructs), which is exactly the lossy seam the [re-drive work](0009-assistant-narration-redrive.md) is closing. The user explicitly chose stateful resume.

### Redis-only session (no Postgres)

Fast and matches the held-conflict pattern. Rejected: a 30-minute TTL (or a restart) would drop a question the user is still entitled to answer — the durability requirement is the whole point.

### Reuse the ADR-0006 conflict path

Tempting (it already suspends + resumes via inline keyboard). Rejected: that path is **deterministic and never re-invokes the model**; `ask_user` must re-invoke. Same mechanism, opposite resume semantics — conflating them would break ADR 0006's guarantee.

## References

- Architecture + the durability/resume design: [specs/assistant-layered-architecture.md](../specs/assistant-layered-architecture.md)
- Pattern source (AskUserQuestion): `AI_COMMS_TOOLSET_RESEARCH.md` §4d
- The deterministic conflict path it must stay distinct from: [ADR 0006](0006-assistant-schedule-context-and-conflicts.md)
- Connector / alert abstraction style: [ADR 0007](0007-provider-connector-abstraction.md)
