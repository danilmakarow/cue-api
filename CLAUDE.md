# Cue API

## Product

Cue is an iOS planner / TODO app. The iOS codebase lives at `~/personal-projects/cue-ios`.

Core features beyond a plain TODO app:
- **Calendar-centric data model** — users own multiple Calendars; tasks, groups, and notification strategies belong to a Calendar (not directly to the user). Sharing calendars with other users is a future capability.
- **Tasks and events unified** — one `Task` entity with optional start/end time (or all-day), optional completion requirement.
- **Recurring tasks** — RFC 5545-inspired RRULE model (`RecurrenceRule`) with per-occurrence overrides (`TaskOccurrenceException`).
- **Notification strategies** — reusable sets of reminder rules. Per-task override falls back to per-group default.
- **Multi-channel notifications** — APNs push + Telegram bot (both planned, not yet wired).
- **Siri integration (iOS side via App Intents)** — BE stores the tasks; iOS exposes the intents.
- **Reporting** — `Task.completedAt` is a timestamp, enabling "what did I do this week" queries.

## Tech stack

- **Runtime**: Node.js 20 + TypeScript
- **Framework**: NestJS 11
- **Database**: PostgreSQL 15 + TypeORM 0.3 (migrations, never `synchronize: true`)
- **Transactions**: `typeorm-transactional` (request-scoped)
- **Cache/Queue**: Redis 7 (in docker-compose; not yet consumed by code — planned for BullMQ outbox worker)
- **Scheduling**: `@nestjs/schedule` is installed (cron/interval decorators) — not yet used
- **Date/time**: `luxon` for tz-aware arithmetic (critical for recurring tasks + DST)
- **Pagination**: `nestjs-paginate` (future — no controllers yet)
- **Validation**: `class-validator` + `class-transformer` (future DTOs); Zod for env schema
- **Auth**: **not yet implemented.** Planned: Apple Sign-In → JWT
- **Notifications**: **not yet implemented.** Planned: APNs + `node-telegram-bot-api`
- **Package manager**: pnpm 10.14
- **Testing**: **not set up yet.** Will add Jest when controllers land.

## Architecture

### Module layout (`src/modules/`)

```
calendar                   ← org unit; User owns Calendars; everything hangs off Calendar
database                   ← single aggregator module (entities, repositories, DatabaseServices)
device                     ← APNs device tokens, per-User
notification-rule          ← one reminder: offsetMinutes + channel
notification-strategy      ← named set of NotificationRules, owned by Calendar
recurrence-rule            ← RRULE (frequency, interval, by-weekday/month/etc., endType)
scheduled-notification     ← outbox table: status, fireAt, channel, attemptCount, userId (delivery target)
task                       ← unified event+task: startAt/endAt/isAllDay, completedAt, timezone, calendarId
task-group                 ← collection of Tasks within a Calendar; has defaultNotificationStrategyId
task-occurrence-exception  ← per-instance override for a recurring Task
telegram-link              ← one-to-one with User
user                       ← appleUserId (Apple `sub`), email, displayName, timezone
```

Each feature module has a `*.module.ts` and a `*.service.ts` skeleton. **No controllers / DTOs yet** — explicit early-stage deferral.

### Data access pattern (STRICT)

```
Entity  →  BaseRepository<T>  →  BaseDatabaseService<T>  →  Feature Service  →  (future) Controller
```

Rules:
- **Direct use of entities or TypeORM repositories outside of `database` module is forbidden.**
- Feature services inject only their corresponding `*DatabaseService`.
- The `database` module registers every entity, repository, and DatabaseService, and exports only the DatabaseServices.
- `BaseEntity` provides `id` (UUID), `createdAt`, `updatedAt`.
- `BaseRepository<T>` wraps `Repository<T>`; `BaseDatabaseService<T>` adds CRUD + throw-on-missing helpers.
- **All creations and updates MUST go through `.save()`.** For creates, build the entity with `createInstance(partial)` and pass it to `save(entity)`. For updates, mutate fields on the already-loaded entity and call `save(entity)`. Do not use `create(partial)`, `update(entity, partial)`, or `updateById(id, partial)` in feature services — those are retained only for the base service internals. On any update path, verify at least one field actually changed before calling `.save()`, and short-circuit (return the entity as-is) when nothing did.

### Domain model — relationships

```
User ─1─* Device                   (cascade on delete)
User ─1─1 TelegramLink             (cascade)
User ─1─* Calendar                 (cascade)

Calendar ─1─* TaskGroup            (cascade)
Calendar ─1─* Task                 (cascade)
Calendar ─1─* NotificationStrategy (cascade)

TaskGroup *─1 NotificationStrategy (default, nullable, SET NULL)
TaskGroup 1─* Task                 (via Task.groupId, nullable, SET NULL)

Task *─1 RecurrenceRule            (nullable, SET NULL)
Task *─1 NotificationStrategy      (override, nullable, SET NULL)
Task 1─* TaskOccurrenceException   (cascade)
Task 1─* ScheduledNotification     (cascade; also cascade from User)

NotificationStrategy 1─* NotificationRule (cascade)
```

Effective notification strategy for a task = `task.notificationStrategyId ?? task.group.defaultNotificationStrategyId`.

### Key schema decisions
- **UUID PKs everywhere** — distributed-friendly, safe for future CloudKit / cross-device sync on the iOS side.
- **`Task.completedAt` timestamp, NOT `isDone` bool** — enables historical reporting for free.
- **Per-task `timezone` field (IANA)** — critical correctness for recurring tasks across DST. All timestamps are `timestamptz`.
- **Soft delete (`@DeleteDateColumn`) on `Task` only** — supports tombstone-based sync with iOS.
- **Recurrence = RRULE + exception rows** — RFC 5545 pattern. Never materialize every occurrence.
- **`ScheduledNotification.userId` is the delivery target** — calendar context is derivable via `task.calendarId`. Do NOT denormalize calendar onto scheduled notifications.
- **`Calendar.ownerId` now; `CalendarMember` later** — YAGNI on sharing. Adding a member join table is a small additive migration when sharing actually ships.

### Path aliases (`tsconfig.json`)

```
@/*            →  src/*
@/config/*     →  src/config/*
@/modules/*    →  src/modules/*
@/services/*   →  src/common/services/*
@/exceptions/* →  src/common/exceptions/*
@/constants/*  →  src/common/constants/*
@/decorators/* →  src/common/decorators/*
@/guards/*     →  src/common/guards/*
@/interceptors/* → src/common/interceptors/*
@/utils/*      →  src/common/utils/*
```

### Env & config

- `@nestjs/config` + Zod validator in `src/config/env.config.ts`.
- Env files read in order: `.env.local` (preferred, gitignored), `.env`.
- DataSource factory: `src/config/typeorm.config.ts`.
- TypeORM CLI shim: `bin/typeorm-cli.config.ts`.
- Current env schema: `NODE_ENV`, `PORT`, `DB_HOST/PORT/USERNAME/PASSWORD/DATABASE`, `DB_SYNCHRONIZE/RUN_MIGRATIONS/LOGGING/DISABLE_SSL_AUTH`. Redis vars exist in `.env.example` but are **not** in the Zod schema yet — add them when Redis is actually consumed.

### Migrations

- Hand-written raw SQL in `src/migrations/{unixMs}-name.ts`.
- The initial migration (`initial-schema.ts`) was edited in place during the Calendar refactor — safe because nothing was in production. **Once data exists in any environment, create NEW migrations instead of mutating existing ones.**
- Commands: `pnpm run migration:{run,generate,create,revert}`.
- `migration:generate` needs a live DB; `migration:create` doesn't.

## Commands

```bash
pnpm install

# Local Postgres + Redis
docker compose -f docker-compose.dev.yml up -d
docker compose -f docker-compose.dev.yml ps     # both should be "healthy"

# DB setup
cp .env.example .env                            # then edit DB_* if needed
pnpm run migration:run

# Dev server
pnpm run start:dev                              # GET /health → { status: 'ok' }

# Quality gates
pnpm run lint
pnpm run type                                   # tsc type-check (no emit)
pnpm run build
pnpm run format
```

## Code style

- **Prettier**: single quotes, trailing commas.
- **ESLint** (flat config): TS recommended-type-checked, `import/order` (builtin → external → internal, alphabetized), `padding-line-between-statements`, `lines-between-class-members`.
- **TypeScript**: `strictNullChecks: true` only — NOT full `strict`. TypeORM entity fields otherwise require `!` on every column. Keep it this way unless a mass-migration to `declare` or bang-syntax is taken.
- **Naming**: kebab-case filenames (`calendar-database.service.ts`, `task.entity.ts`), PascalCase classes/enums, UPPER_SNAKE_CASE constants.
- **Class ordering**: fields (static → private → public), constructor, methods (static → private → public getters/setters → public methods).
- **Class methods**: Use actual class methods, NOT arrow functions as class properties. Methods should use `async method() {}` syntax, not `method = async () => {}`.
- **Functions**: arrow functions, early-exit pattern (`if (!ok) return;` then main path), JSDoc on every new function.
- **Types**: no `any` — find or create an appropriate type.
- **Enums**: declared inside their entity file and re-exported from `src/modules/database/entities/index.ts`.
- **No barrel-importing entities/repositories from feature modules** — import from the specific `*DatabaseService` instead.

## Docker

- `docker-compose.dev.yml` — Postgres 15-alpine + Redis 7-alpine, both with healthchecks and named volumes (`postgres_data`, `redis_data`).
- `init-scripts/` is mounted at `/docker-entrypoint-initdb.d` on the Postgres container. Add `*.sql` / `*.sh` there to run on first DB init. Currently empty (kept via `.gitkeep`).

## Current state / deferred follow-ups

Everything below is known-missing; don't treat absence as a bug.

- **Feature services are empty skeletons.** No CRUD methods, no endpoints, no DTOs yet.
- **No auth.** Apple Sign-In → JWT + `AccessTokenGuard` is the plan. `User.appleUserId` column exists.
- **No default calendar on signup.** When auth lands, signup MUST auto-create a default `Calendar` for the new user — otherwise `Task`/`TaskGroup`/`NotificationStrategy` inserts have no valid `calendarId`.
- **No notification delivery.** `ScheduledNotification` rows are schema-only. Planned: BullMQ worker polling `status = PENDING AND fireAt <= now` (composite index already present), then APNs / Telegram clients.
- **No recurrence expansion.** `RecurrenceRule` is schema-only; need a service that expands a rule into upcoming occurrences and materializes `ScheduledNotification` rows (respecting `TaskOccurrenceException`).
- **No tests.** No Jest config, no `*.spec.ts` files.
- **No Swagger / Sentry / Winston.** Intentionally omitted from the initial scaffold.
- **No `CalendarMember` / sharing.** Additive migration when sharing actually ships.
- **Redis env vars not in Zod schema.** Add when Redis is consumed.

## Conventions for agents working here

- Follow the established 3-layer data access pattern exactly. Never inject a `Repository<T>` or entity directly into a feature service.
- Use `timestamptz` for every time column and always include a per-entity `timezone` string if the behavior is time-of-day-local.
- Don't add backwards-compat shims or feature flags for features that haven't shipped yet.
- If a task requires adding a new entity, add it in this order: entity → repository → database service → register in `DatabaseModule` → feature module + service → migration.
