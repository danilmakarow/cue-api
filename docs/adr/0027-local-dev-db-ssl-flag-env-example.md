# 0027 — local-dev-db-ssl-flag-env-example

- **Status**: Accepted
- **Date**: 2026-06-20
- **Deciders**: @danil

## Context

`getDatabaseConfig` ([src/config/typeorm.config.ts](../../src/config/typeorm.config.ts)) maps the
`DB_DISABLE_SSL_AUTH` env flag to a TypeORM `ssl` option: when the flag is truthy it sets
`ssl: { rejectUnauthorized: false }`. That option does **not** disable SSL — it still **negotiates**
an SSL handshake, it merely skips certificate verification. It exists for a remote/managed Postgres
(e.g. RDS) that **requires** SSL but presents a cert we don't pin.

`.env.example` shipped this flag as `DB_DISABLE_SSL_AUTH=true`. The onboarding path in
[CLAUDE.md](../../CLAUDE.md) is `cp .env.example .env`, so a new contributor's first `.env` inherits
`true`. But the local stack is `postgres:15-alpine` from `docker-compose.dev.yml`, which has **SSL
compiled off** and **refuses any SSL handshake** with:

> The server does not support SSL connections

So the documented quickstart (`cp .env.example .env` → `pnpm run migration:run` /
`pnpm run start:dev`) fails on a fresh clone with a confusing SSL error, even though the developer
did nothing wrong. `.env.test` had already worked around this for the test/e2e path by pinning
`DB_DISABLE_SSL_AUTH=false` with an explanatory comment; the `.env.example` template was the
remaining footgun. The flag's name reads like "disable SSL," which makes `true` look correct for a
no-SSL local box — the exact opposite of its real effect.

## Decision

Set **`DB_DISABLE_SSL_AUTH=false` in `.env.example`** (Option 1), with a comment explaining that
`true` (→ `ssl: { rejectUnauthorized: false }`) is for a remote/managed Postgres that *requires*
SSL, while the local docker Postgres needs `false` so **no `ssl` key is set** and the driver
connects in plaintext.

`getDatabaseConfig` semantics, the flag name, the Zod `booleanValidator` schema, `.env` (the
developer's local file), and the production env/SSM are **left untouched**. Production continues to
rely on `true → ssl: { rejectUnauthorized: false }` for its managed Postgres — that path is
unchanged. Because the schema is unchanged, no [CLAUDE.md](../../CLAUDE.md) env-schema edit is
required.

## Consequences

- ✅ `cp .env.example .env` now yields a working local connection out of the box — the documented
  quickstart succeeds on a fresh clone with no SSL error.
- ✅ The inline comment turns a counter-intuitively-named flag into a self-explaining one at the
  exact spot a contributor reads it.
- ✅ **Zero production blast radius**: only the example template changed; runtime mapping, the flag
  name, the Zod schema, `.env`, and prod SSM are all byte-identical. Prod's `true →
  rejectUnauthorized:false` SSL path is preserved.
- ⚠️ The flag remains misleadingly named (`DISABLE_SSL_AUTH` actually means "negotiate SSL but skip
  cert verification"). This fix documents around the name rather than fixing it — see the rejected
  Option 2.
- ⚠️ A developer deploying against a *remote* SSL-requiring Postgres must remember to flip the flag
  back to `true` in their own `.env`; the comment calls this out.

## Alternatives considered

### Option 2 — rename the flag to express real intent (e.g. `DB_SSL_MODE` / `DB_REQUIRE_SSL`)

Replace the misleadingly-named `DB_DISABLE_SSL_AUTH` with a flag whose name matches its true effect,
so neither value is a trap. **Rejected as out of proportion to a local-dev footgun.** A rename is not
a `.env.example` edit — it touches `getDatabaseConfig`, the Zod schema in `env.config.ts`, the
production **SSM parameters / infra**, every existing `.env*` file, and the CLAUDE.md env-schema
list, and it carries real production risk (a missed SSM update silently changes prod's SSL behaviour).
That is a disproportionate, prod-reaching change to fix a `cp .env.example .env` onboarding paper-cut.
Option 1 fixes the actual reported problem with no prod surface; if the name is to be fixed, that is
its own deliberate migration ADR, not a rider on this fix.

### Leave `.env.example` as-is and document the gotcha elsewhere

Keep `true` and add a note in CLAUDE.md / README telling contributors to flip it. **Rejected** — it
keeps the default-broken quickstart and relies on every contributor reading and remembering a note;
the value that actually gets copied should just be correct for the stack the example targets.

## References

- Flag → `ssl` mapping under test: [src/config/typeorm.config.ts](../../src/config/typeorm.config.ts) `getDatabaseConfig`
- Pre-existing precedent for the same fix on the test path: `.env.test` (`DB_DISABLE_SSL_AUTH=false` + comment)
- Onboarding path that copies the template: [CLAUDE.md](../../CLAUDE.md) *Commands* (`cp .env.example .env`)
- Accompanying lifecycle-correctness fix landed alongside this one: [ADR 0028](0028-redis-client-shutdown-lifecycle.md)
