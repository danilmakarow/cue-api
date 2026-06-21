# 0046 — assistant-daily-report-scheduler

- **Status**: Accepted
- **Date**: 2026-06-21
- **Deciders**: @danil

## Context

v2 Story 17 adds a per-day notification report: once a day, at a user-chosen
local wall-clock time, the assistant sends the user a short, friendly briefing of
their day's agenda over Telegram. Three forces shape the design:

1. **Time-of-day is local and DST-sensitive.** "08:00" means 08:00 in the user's
   own timezone (`User.timezone`), regardless of where they currently are or DST —
   the same discipline tasks already follow. The scheduler must evaluate each
   user against *their* wall clock, not the server's.
2. **At-most-once per local day.** A naïve cron that fires "when the time matches"
   would re-send every minute the clock reads `08:00`, and again after a restart.
   We need an idempotency guard keyed on the user's local date.
3. **There is no delivery worker yet (Corrected Assumption 3).** The
   [`notification-delivery`](../specs/notification-delivery.md) spec is still
   Draft: `ScheduledNotification` is a schema-only outbox and **no worker drains
   it**. Story 17's report has nowhere durable to go. Building the full outbox
   worker is out of scope for this story.

## Decision

We add a **`UserReportSettings`** entity (per-user `enabled`, `reportTimeLocal`
`HH:mm`, `lastSentLocalDate` `YYYY-MM-DD|null`), a REST surface
**`GET`/`PATCH /users/me/report-settings`** behind `AccessTokenGuard`, and a
**per-minute `@nestjs/schedule` `@Cron`** scheduler.

Each minute the scheduler scans the opted-in (`enabled`) rows, computes each
user's local `HH:mm` and date from `User.timezone` via **luxon**, and — when the
local time matches `reportTimeLocal` **and** `lastSentLocalDate` is not already
the user's current local date — generates **one** report and sends it.

- **Idempotency:** `lastSentLocalDate` is set to the user's local date and
  persisted **before** the send; any later scan in the same local day sees the day
  covered and skips. An empty generation or a missing Telegram link leaves the day
  un-marked so a later minute can retry.
- **Report generation:** **one** MAIN-model `AiConnector.complete()` call — no
  tool loop, no dispatcher. The agenda comes from
  `TaskService.findOccurrencesInRange` for the user's local day (recurrence
  expanded, exceptions applied, DST-correct).
- **Delivery — INTERIM direct-send:** because the durable worker does not exist,
  the report is sent **straight through the active Telegram vendor connector** to
  the user's linked `telegramChatId`. This is a deliberate stopgap.
- **Resilience:** each user is processed under its own `try/catch`
  (degrade-never-throw); one user's generation/send failure is logged and never
  aborts the scan for the others. Telegram exposes **no** config — settings are
  REST/iOS only.

> **Follow-up (not this story):** the durable `ScheduledNotification` delivery
> worker (BullMQ, `status = PENDING AND fireAt <= now`, retries, audit) remains a
> separate piece of work. When it lands, `ReportSenderService` should enqueue a
> `ScheduledNotification` rather than calling the vendor directly, and the
> scheduler's "mark then send" can move behind the outbox's at-least-once
> semantics. The interim direct-send is intentionally at-most-once.

## Consequences

- ✅ Users get a localized daily briefing without waiting on the full notification
  outbox; Story 17 ships now on the lower-lift unblock.
- ✅ The per-minute scan is cheap: an `enabled` btree index narrows the candidate
  set, and the per-user time/date match is in-memory.
- ✅ Idempotency is a single string compare (`lastSentLocalDate === localDate`) —
  trivial to reason about and restart-safe.
- ✅ One-shot generation keeps cost bounded and latency predictable (no loop).
- ⚠️ **Interim direct-send is at-most-once, not durable.** A vendor send fault
  after the day is marked drops that day's report (no retry); we accept this for
  the stopgap. The durable worker is the fix.
- ⚠️ A per-minute cron does a (small) DB read every minute even when nobody is due.
  Acceptable at current scale; revisit if the opted-in set grows large.
- ⚠️ The scheduler runs in every app instance. At single-instance scale this is
  fine; horizontal scaling will need a shared lock (the Story 11 Redis mutex is the
  natural home) to avoid N sends. Noted, not built.

## Alternatives considered

### Block on the durable `ScheduledNotification` delivery worker first

Sequence the BullMQ outbox worker, then have the report write a
`ScheduledNotification` row. Rejected for **this** story: it is materially more
work (materializer reconcile, `FOR UPDATE SKIP LOCKED` dispatch, backoff, channel
clients) and Story 17's value — a localized daily briefing — does not depend on
durability to be useful. The interim direct-send unblocks now; the worker is the
honest follow-up, recorded above.

### Per-user scheduled jobs (BullMQ delayed job per user per day)

Enqueue a delayed job at each user's next local fire time. Rejected: it duplicates
schedule state in Redis, complicates re-computation when a user changes their time
or timezone (cancel + re-arm), and a per-minute scan over an indexed `enabled` set
is plenty cheap at this scale. Postgres stays the single source of truth.

### Store `reportTimeLocal` as a `timestamptz` / UTC minute

Rejected: a UTC instant cannot express "08:00 local every day" across DST without
re-derivation, and it would drift when the user travels. A wall-clock `HH:mm`
string interpreted in `User.timezone` is the correct, DST-safe representation —
the same reasoning behind the per-task `timezone` column (ADR 0002 family).

### Mark the day sent AFTER a confirmed send

Rejected as the default: a crash between send and mark would re-send on the next
minute. Marking **before** the send makes the common path at-most-once and
restart-safe; the only loss is a report dropped on a send fault, which the durable
worker will later make at-least-once. (A missing link / empty report explicitly
rolls the mark back, since nothing was delivered.)

## References

- Plan: [ai-workflow v2 plan — Story 17 + Corrected Assumption 3](../specs/ai-workflow-v2-plan.md)
- Delivery prerequisite (still Draft): [notification-delivery](../specs/notification-delivery.md)
- Entity / REST: `src/modules/database/entities/user-report-settings.entity.ts`,
  `src/modules/report/report-settings.controller.ts`
- Scheduler: `src/modules/report/daily-report.scheduler.ts`
- HTTP contract: [`openapi.yaml`](../api/openapi.yaml) → `/users/me/report-settings`
- Connector abstraction: [ADR 0007](0007-provider-connector-abstraction.md)
