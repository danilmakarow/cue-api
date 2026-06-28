# Cue API

The HTTP backend for [**Cue**](../cue-ios), an iOS calendar / TODO planner. It owns the canonical
task, calendar, and notification data; exposes a REST API consumed by the iOS client; and runs a
Telegram **AI assistant** (Claude-backed) that lets users manage their calendar in natural language.

> **Sibling repo:** the iOS app lives at `../cue-ios`. The HTTP contract between them is
> [`docs/api/openapi.yaml`](docs/api/openapi.yaml).

---

## What it does

**Domain & data model**
- **Calendar-centric** — a `User` owns multiple `Calendar`s; tasks, groups, and notification
  strategies belong to a Calendar (not directly to the user). Calendar sharing is a future
  additive migration.
- **Tasks and events unified** — one `Task` entity with optional start/end time (or all-day) and
  optional completion requirement. `completedAt` is a timestamp (not an `isDone` bool), so historical
  reporting comes for free.
- **Recurring tasks** — RFC 5545-inspired RRULE stored inline as a JSONB `recurrenceConfig` on `Task`
  and `TaskGroup`. Occurrences are expanded on read (never materialized); only divergences are
  persisted as `TaskOccurrenceException` rows. Expansion is DST-correct via per-task IANA `timezone`.
- **Notification strategies** — reusable sets of reminder rules; a per-task override falls back to the
  group default. Effective task/group/default settings (recurrence, `requiresCompletion`, `color`)
  resolve task-wins.

**Implemented surface**
- **Auth** — Apple Sign-In → JWT, plus a `auth/dev` break-glass login for local development.
- **REST API** — calendars, tasks (CRUD + occurrence-aware reads, per-occurrence completion & skip,
  `changes` delta sync, `search`, `daily-counts`), task-groups (CRUD + reorder), devices (APNs token
  registration), user account & settings, persona settings/presets, report settings & daily brief,
  and `.well-known/apple-app-site-association` for iOS universal links.
- **Telegram AI assistant** — webhook ingress → BullMQ queue → tool-use loop → reply. Backed by
  provider-agnostic **AI** (Anthropic), **external-vendor** (Telegram), and **STT** (OpenAI, for voice
  notes) connectors. Includes conversation memory, per-user persona, live status / draft streaming,
  AI-judged scheduling conflicts, account linking, and a daily-report scheduler. See
  [`docs/specs/telegram-ai-assistant.md`](docs/specs/telegram-ai-assistant.md).
- **Swagger** — interactive API docs served at `/docs` when the app is running.

**Planned (schema/skeleton present, delivery not wired)**
- Notification **delivery** — `ScheduledNotification` is an outbox table; the BullMQ worker that
  fans rules out to APNs / Telegram is not built yet. See
  [`docs/specs/notification-delivery.md`](docs/specs/notification-delivery.md).
- `CalendarMember` sharing.

> **Note on the older docs:** `CLAUDE.md` and `docs/architecture.md` contain a few stale "not built
> yet" lines (e.g. "no controllers", "no tests"). The code is the source of truth for behaviour —
> this README reflects the current state.

---

## Tech stack

| Concern | Choice |
|---|---|
| Runtime | Node.js 20+ · TypeScript |
| Framework | NestJS 11 |
| Database | PostgreSQL 15 · TypeORM 0.3 (migrations only — never `synchronize: true`) |
| Transactions | `typeorm-transactional` (request-scoped) |
| Cache / queue | Redis 7 · BullMQ (assistant webhook queue, dedupe, link nonces, held-conflict mirror) |
| Scheduling | `@nestjs/schedule` (`@Cron` jobs — daily report, pending-question cleanup) |
| Date / time | `luxon` (DST-correct recurrence) |
| Validation | `class-validator` + `class-transformer` (DTOs); `zod` (env schema) |
| Auth | Apple Sign-In → JWT (`@nestjs/jwt`, `jwks-rsa`) |
| AI / STT | `@anthropic-ai/sdk` (assistant) · `openai` (speech-to-text) |
| API docs | `@nestjs/swagger` → `/docs` |
| Package manager | pnpm 11 |
| Testing | Jest — unit (`*.spec.ts`) + e2e (`*.e2e-spec.ts`) |

---

## Documentation

`docs/` is the source of truth for **intent and decisions**; the code is the source of truth for
**behaviour**. Start at [`docs/README.md`](docs/README.md) for the rules of the road.

```
docs/
  README.md           ← orientation; how/when to write each kind of doc
  architecture.md     ← one-page system overview (stack, modules, data model, request lifecycle)
  adr/                ← Architecture Decision Records — one decision per file, immutable once accepted
                        (0001–0059; mostly the assistant's AI-comms design history)
  specs/              ← per-feature / per-system design docs (auth, recurrence, assistant, REST, …)
  tasks/              ← implementation work items broken out of a ready spec
  api/openapi.yaml    ← the HTTP contract — the bridge consumed by cue-ios
  refactor/           ← active refactor PLAN.md + BE_BACKLOG.md
```

| Need | Read / write |
|---|---|
| 10,000-ft overview | [`docs/architecture.md`](docs/architecture.md) |
| Why a decision was made | [`docs/adr/`](docs/adr/) (append-only; supersede, never edit) |
| How a feature is designed | [`docs/specs/`](docs/specs/) |
| The exact HTTP endpoints/shapes | [`docs/api/openapi.yaml`](docs/api/openapi.yaml) |

---

## Running locally

**Prerequisites:** Node.js 20+, pnpm 11, Docker (for Postgres + Redis).

```bash
# 1. Install dependencies
pnpm install

# 2. Create your env file — every var is validated at boot (Zod) and the app
#    refuses to start if any is missing or malformed. See .env.example for docs on each.
cp .env.example .env          # then fill in JWT_SECRET, and any Telegram/Anthropic/OpenAI keys

# 3. Start Postgres 15 + Redis 7 (reads DB_*/REDIS_* from .env)
docker compose -f docker-compose.dev.yml up -d
docker compose -f docker-compose.dev.yml ps     # both should report "healthy"

# 4. Run database migrations
pnpm migration:run

# 5. Start the dev server (watch mode)
pnpm dev
```

On boot the app prints its URL and Swagger location. Verify it's up:

```bash
curl http://127.0.0.1:3000/health     # → { "status": "ok" }   (PORT is set in .env)
```

- **API docs:** open `http://127.0.0.1:<PORT>/docs` for the live Swagger UI.
- **Telegram assistant:** the webhook needs a public HTTPS URL. Point `ASSISTANT_WEBHOOK_URL` at a
  tunnel and expose your local port — `pnpm ngrok-dev` opens an ngrok tunnel (set `PORT` to match).
  Without valid `TELEGRAM_BOT_TOKEN` / `ANTHROPIC_API_KEY`, registration fails non-fatally and the
  rest of the API still runs.

### dev-cli (break-glass utilities)

A small Nest-context CLI for local provisioning — **never expose on a production host.**

```bash
# Create a user (also seeds their default calendar)
pnpm dev-cli create-user --appleUserId dev-danil --email danil@example.com \
  --displayName "Danil M" --timezone Europe/Warsaw

# Mint a JWT for them (by appleUserId or by UUID)
pnpm dev-cli issue-token --appleUserId dev-danil
pnpm dev-cli issue-token --userId <uuid>

pnpm dev-cli help
```

### Migrations

Migrations are hand-written raw SQL under `src/migrations/`.

```bash
pnpm migration:run          # apply pending migrations
pnpm migration:generate     # generate from entity diff (needs a live DB)
pnpm migration:create       # empty migration (no DB needed)
pnpm migration:revert       # roll back the last one
```

### Quality gates

```bash
pnpm lint      # ESLint (incl. Prettier)
pnpm type      # tsc type-check, no emit
pnpm build     # nest build + tsc-alias
pnpm format    # prettier --write
```

---

## Running tests

### Unit tests

Pure / mocked Jest specs (`src/**/*.spec.ts`) — no Docker, no DB required.

```bash
pnpm test                 # run all unit specs
pnpm test:watch           # watch mode
pnpm test:cov             # with coverage report
```

### End-to-end tests

E2E specs (`test/**/*.e2e-spec.ts`) boot the real Nest app against a **dedicated** test stack. The
harness (`test/e2e/global-setup.ts`) automatically spins up an isolated Postgres + Redis via
`docker-compose.test.yml` (a separate Compose project, `cue-api-test`, with its own volumes — it can
never touch your dev database), sourcing ports/credentials from `.env.test`.

`.env.test` is gitignored. If it's missing, copy `.env.example` to `.env.test` and point `DB_*` /
`REDIS_*` at the local docker infra (the "Generate .env.test" step in
`.github/workflows/_functionality.yml` is a known-good reference set of values).

```bash
pnpm test:e2e        # brings up the test infra, runs e2e, tears it down (runInBand)
```

- The LLM and Telegram vendors are **scripted/captured** by default (no network, deterministic).
- `pnpm test:e2e:real` runs the assistant against the **real** Anthropic API (`E2E_LLM=real`) —
  requires a valid `ANTHROPIC_API_KEY` in `.env.test`.
- `E2E_SKIP_DOCKER=1` runs against already-running infra (faster local iteration); the harness still
  truncates/flushes between tests.
- `pnpm test:e2e:debug` adds `--detectOpenHandles`.

### CI

`.github/workflows/ci.yml` runs on every PR: **stage 1** quality (`pnpm lint` + `pnpm type`), then
**stage 2** functionality (`pnpm test` + `pnpm test:e2e`). The same two stages gate deploys.

---

## Project layout

```
src/
  main.ts                 ← bootstrap (CORS, Swagger, listen)
  app.module.ts           ← root module
  config/                 ← env (Zod), TypeORM datasource, Swagger
  migrations/             ← hand-written raw-SQL migrations
  common/                 ← decorators, guards, exceptions, utils
  modules/
    ai · external-vendor · stt        ← provider-agnostic connectors (Anthropic / Telegram / OpenAI)
    assistant                         ← Telegram AI assistant (webhook → queue → tool loop → reply)
    auth · user · device · telegram-link
    calendar · task · task-group · task-occurrence-exception
    recurrence-rule                   ← DB-less RRULE expansion engine
    notification-rule · notification-strategy · scheduled-notification
    persona · report · alert · redis · swagger · well-known
    database                          ← single aggregator: entities, repositories, DatabaseServices
bin/
  dev-cli.ts              ← create-user / issue-token
  typeorm-cli.config.ts   ← TypeORM CLI datasource shim
docs/                     ← see Documentation above
infra/                    ← Terraform (EC2 deploy; see docs/specs/deployment-and-cicd.md)
```

### Data-access pattern (strict)

```
Entity → BaseRepository<T> → BaseDatabaseService<T> → FeatureService → Controller
```

Direct use of entities or TypeORM repositories outside the `database` module is forbidden; feature
services inject only their `*DatabaseService`. All writes go through `.save()`. See
[`CLAUDE.md`](CLAUDE.md) for the full conventions agents and contributors follow.

---

## Deployment

Terraform-provisioned single EC2 host behind Caddy (TLS); deployed by GitHub Actions on push to
`master` after the CI stages pass. See [`docs/specs/deployment-and-cicd.md`](docs/specs/deployment-and-cicd.md)
and `infra/`.
