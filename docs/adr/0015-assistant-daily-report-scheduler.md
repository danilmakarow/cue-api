# 0015 — assistant-daily-report-scheduler

- **Status**: Accepted
- **Date**: 2026-06-19
- **Deciders**: @danil

## Context

v2 wants a **per-day report**: at a user-chosen local time, build the day's data, summarize it with the AI in one shot, and deliver it — configured **from the app, not Telegram**.

The platform recon found:

- **`@nestjs/schedule` is installed but unused**; BullMQ is the live scheduler. **No delivery worker exists** — `ScheduledNotification` is a schema-only outbox (PENDING/SENT/FAILED), and the APNs/Telegram send paths are unimplemented.
- **`User.timezone` (IANA) exists** and `luxon` is used throughout, so "each day at a chosen local time" is computable — but per-user-timezone cron is non-trivial (a single global cron fires once; you must scan opted-in users whose local time matches now).
- **There is no web management UI** (Swagger at `/docs` aside) — the only client is the Cue iOS app. There is **no `UserPreferences` entity**.

The product owner chose **iOS + REST** for configuration (not a web admin, not Telegram).

## Decision

We add a **`UserReportSettings`** entity (`reportEnabled`, `reportTimeLocal`, `reportChannel`, `reportPromptOverride` nullable; the default prompt lives in code) and **`GET`/`PATCH /users/me/report-settings`** behind `AccessTokenGuard` (the iOS app owns the screen; `openapi.yaml` updated in the same PR). A **`@nestjs/schedule` per-minute job** scans opted-in users whose `User.timezone` local time matches `reportTimeLocal` (luxon), **idempotent** via a per-user "last sent date" guard, and enqueues a **BullMQ build-and-send job**. That job builds the day's report, makes **one AI request → one response** (default prompt, overridable per-user; **no tool loop**), and delivers via the Telegram connector. The **`ScheduledNotification` delivery worker is the prerequisite** and ships first (or the report sends directly through the connector in the interim). Telegram exposes **no** configuration for this feature.

## Consequences

- ✅ A genuinely useful daily ritual: per-user time + custom prompt, one cheap AI call, one message.
- ✅ Reuses the existing connector + the already-installed scheduler; settings live where user settings already live (iOS).
- ⚠️ **Blocked on the delivery worker** — the outbox is schema-only today; that work lands first.
- ⚠️ **Per-user-timezone cron**: the per-minute global scan is simplest and cheap at current scale; per-user repeatable jobs are operationally heavier — revisit only at scale.
- ⚠️ Must be **idempotent across deploy restarts** (a deploy mid-minute must not double-send) — the per-user last-sent-date guard enforces this.
- ⚠️ New env vars (cron expression / lookahead) must land in the Zod schema **and** `infra/production/ssm.tf` **and** `.env.example` together.

## Alternatives considered

### A web admin UI for configuration

Rejected — no web UI exists, the iOS app already owns user settings, and "not via Telegram" is satisfied by iOS. A web admin is only worth it when non-user operators must manage shared templates.

### Per-user BullMQ repeatable jobs (one schedule per user)

Rejected for v1 — operationally heavier than a single per-minute scan at current user counts; reconsider at scale.

### A multi-turn agentic report (tool loop)

Rejected — the spec is one request / one response; it is cheaper, predictable, and sufficient for a summary.

### Configure it from Telegram

Excluded by the brief.

## References

- Research: [ai-workflow-v2-research §F](../specs/ai-workflow-v2-research.md) · design: [ai-workflow-tasks Story 17](../specs/ai-workflow-tasks.md)
- The outbox + delivery model: `ScheduledNotification` (see CLAUDE.md "No notification delivery") · memory/cost model: [ADR 0005](0005-assistant-conversation-memory-model.md)
</content>
