# 0028 — redis-client-shutdown-lifecycle

- **Status**: Accepted
- **Date**: 2026-06-20
- **Deciders**: @danil

## Context

The shared ioredis client is registered in [RedisModule](../../src/modules/redis/redis.module.ts) as
a **`useFactory` value provider** under the `REDIS_CLIENT` token — the factory returns a bare
`new Redis(...)`. Its JSDoc claimed the client "is disconnected on application shutdown via the
`onModuleDestroy` hook below," but **no such hook existed**. Nest only invokes lifecycle hooks
(`onModuleDestroy`, `OnApplicationShutdown`) on provider instances **of a class**; a value returned
from a `useFactory` carries no hook, so the ioredis TCP socket was never closed on `app.close()`.

The leak is visible in the e2e teardown: `test/e2e/harness.ts` `close()` had to call
`this.redis.quit()` itself, with a comment noting *"The `REDIS_CLIENT` provider has no shutdown hook
of its own, so without this quit the open socket would leak as a jest open-handle."* That harness
quit is a workaround for the missing module-level hook, not a substitute for it — any other consumer
that boots and closes the app (future integration tests, a graceful-shutdown path) would still leak.

## Decision

Add a thin `@Injectable` **`RedisLifecycle`** class to `RedisModule` that injects `REDIS_CLIENT` and
implements `OnModuleDestroy`. Its `onModuleDestroy` quits the shared client, guarding against a
double-quit / already-closing client (returns early when `redis.status` is `end`/`close`, and
swallows any `quit()` rejection so teardown never throws). It is registered alongside the
`REDIS_CLIENT` value provider in the module's `providers`. The existing factory **connection options
are unchanged** (`host`/`port`/`password`/`db`/`maxRetriesPerRequest: null`); only the lifecycle hook
is added, and the provider JSDoc is corrected to describe the real hook owner.

The harness's own `redis.quit()` in `close()` is **kept as belt-and-suspenders** — it is idempotent
with the new hook (the second quit is a no-op / swallowed) and keeps the harness robust even if the
module wiring regresses.

## Consequences

- ✅ The ioredis socket is now closed by the module itself on `app.close()`, so the client no longer
  leaks as a jest open handle and the provider JSDoc is finally accurate.
- ✅ Every app-close path benefits, not just the one harness that hand-rolled a `quit()` — future
  integration tests and graceful shutdown get correct teardown for free.
- ✅ Connection behaviour is untouched (same options), so there is no runtime risk to the live
  client; the change is purely a teardown addition.
- ⚠️ `onModuleDestroy` fires on an explicit `app.close()`. For it to also fire on an **OS signal**
  (SIGTERM/SIGINT) the app must call `app.enableShutdownHooks()`, which `src/main.ts` does **not**
  currently do (out of scope here). Recommended follow-up: enable shutdown hooks in `main.ts` so the
  production process closes Redis (and TypeORM) cleanly on SIGTERM, not just on a programmatic close.

## Alternatives considered

### Convert `REDIS_CLIENT` itself into a class provider implementing the hook

Replace the value factory with a `@Injectable` class that *is* the client wrapper and owns the hook.
**Rejected** as a larger blast radius: every injection site (assistant orchestrator, consumer, e2e
harness) resolves `REDIS_CLIENT` to a raw `Redis` instance today; wrapping it would change the
injected type and ripple through call sites and the BullMQ wiring. A separate lifecycle class keeps
the token's resolved type (`Redis`) and the connection options exactly as-is.

### Leave the harness `quit()` as the only teardown

Do nothing in the module and rely on each consumer to quit the client. **Rejected** — it makes
correct teardown the caller's responsibility (the original bug), contradicts the provider's own
JSDoc, and leaks for any consumer that forgets. The lifecycle belongs with the provider that owns the
connection.

## References

- The provider and new hook: [src/modules/redis/redis.module.ts](../../src/modules/redis/redis.module.ts) (`REDIS_CLIENT`, `RedisLifecycle`)
- The workaround this corrects: `test/e2e/harness.ts` `close()` (kept as belt-and-suspenders)
- Accompanying local-dev config fix landed alongside this one: [ADR 0027](0027-local-dev-db-ssl-flag-env-example.md)
