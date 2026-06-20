# 0021 — assistant-e2e-real-request-harness

- **Status**: Accepted
- **Date**: 2026-06-20
- **Deciders**: @danil

## Context

The assistant engine is covered today by **27 `*.spec.ts` unit tests** that mock their
dependencies ([CLAUDE.md *Current state*](../../CLAUDE.md)) — the AI connector, the queue, the
DB, and the outbound Telegram send are all doubles. That is the right altitude for the orchestrator
logic, but it leaves the **wiring between the layers untested**: the two-phase
`webhook → BullMQ → tool loop → DB` pipeline ([ai-workflow §1](../specs/ai-workflow.md#1-end-to-end-flow))
is precisely where the engine's correctness lives — secret-token auth, the `200`-fast enqueue, the
Redis dedupe guard, user resolution, the serial tool dispatch, and the held-conflict / re-drive
terminal branches — and **none of it runs end-to-end in CI**. The deploy spec already anticipates
this gap: *"a `postgres:15` service gets added when integration tests (`test:e2e`) land"*
([deployment-and-cicd §CI](../specs/deployment-and-cicd.md#components)), and the backlog tracks
**"an e2e harness + a CI coverage gate"** as the remaining test gap.

A real-request harness for an **LLM-driven** engine faces a tension the deploy pipeline does not:

- The pipeline is **asynchronous and two-phase on purpose** — the HTTP request only authenticates
  and enqueues (returns `200` so Telegram won't redeliver), and all real work runs off the request
  path in the BullMQ consumer ([ai-workflow §1](../specs/ai-workflow.md#1-end-to-end-flow)). A test
  cannot assert on the DB the instant the `200` returns — the turn hasn't run yet.
- The **outbound vendor** (Telegram send) must not fire real network calls in a test, but the test
  still needs to assert *what the engine decided to say / which inline keyboard it offered*.
- The **AI connector is non-deterministic**: a real Anthropic call can never be the gating
  assertion (it would make CI flaky and cost money on every push), yet we still want a way to prove
  the loop survives a *genuinely real* model round-trip — schema-valid tool calls, real
  `stop_reason`s, real prompt-cache behaviour — not just a hand-written script.

The unit suite must stay fast and key-free (`pnpm test`); the e2e suite needs Docker, a real DB, and
a real Redis, so the two cannot share a runner config.

## Decision

Add a **separate Jest e2e suite** (`pnpm test:e2e`, `test/jest-e2e.json`) that boots the **real
NestJS application and the real `webhook → BullMQ → tool loop → DB` pipeline** against a **real test
Postgres + Redis** from `docker-compose.dev.yml`. It drives the engine the way Telegram does —
an HTTP `POST` to the webhook (via `supertest`) carrying the secret token — so auth, the
`200`-fast enqueue, dedupe, resolution, and the consumer all execute for real.

Two collaborators are swapped, everything else is real:

- **Outbound vendor → a capturing fake.** The Telegram send connector is replaced (Nest provider
  override) with an in-memory **capturing fake** that records every outbound reply / inline keyboard
  instead of hitting the Bot API. Assertions read what the engine *decided to send*; no network,
  no real bot token.
- **AI connector → two selectable modes** behind the provider-neutral `ai.types.ts` boundary
  ([ADR 0007](0007-provider-connector-abstraction.md)), so the engine code is byte-identical in both:
  1. **Deterministic scripted connector — the gating assertions.** A fake connector that returns a
     **pre-scripted sequence of `CompletionResult`s** (text + `tool_use` blocks + `stop_reason`)
     per turn. This is what CI runs: **no `ANTHROPIC_API_KEY`, no cost, fully repeatable**. Because
     it controls the model's output exactly, it can assert **engine-level facts precisely** — "a
     `create_tasks` of 7 items with one clash commits 6 and **holds** 1 through the inline keyboard"
     ([ADR 0020](0020-assistant-batch-create-tasks.md)), "a narration-without-write `END_TURN`
     **re-drives** with `toolChoice:'any'` and then commits" ([ADR 0009](0009-assistant-narration-redrive.md),
     [ADR 0019](0019-assistant-neutral-ai-tool-choice.md)), "a duplicate webhook body is
     **dropped** by the dedupe guard."
  2. **Opt-in real-Anthropic mode — truly real requests.** Behind a flag (e.g.
     `E2E_REAL_LLM=1`) **and** a present `ANTHROPIC_API_KEY`, the suite uses the **real Anthropic
     connector** and issues **genuine** model round-trips. Because the LLM is non-deterministic,
     these tests assert only **loose engine-level invariants** that must hold for *any* sane model
     output — every inbound yields exactly one outbound reply; no turn throws (the `attempts:1`
     return-never-throw invariant, [ai-workflow §11](../specs/ai-workflow.md#11-retries--resilience--every-layer));
     a "create a task tomorrow" turn ends with **≥1 committed write or a clarifying question**
     (never a silent false-success, [ai-workflow §10](../specs/ai-workflow.md#10-success-integrity-guard-the-trick-that-catches-lies)) —
     **never** an exact reply string. This mode is **opt-in and non-gating**: it never runs in CI by
     default, never blocks a merge, and never costs money on a push.

**Awaiting the async turn.** Because the webhook returns `200` before the consumer runs the turn,
the harness does **not** assert on the bare HTTP response. It captures the enqueued job and awaits
its completion with **BullMQ's own `QueueEvents` + `job.waitUntilFinished(queueEvents)`** (bullmq is
already a dependency) before asserting on the DB and the captured outbound — the queue's native
completion signal, with a bounded timeout, rather than a `sleep` or a poll loop. This exercises the
real two-phase boundary instead of papering over it.

**Isolation from the unit suite.** The e2e suite is **fully separate from `pnpm test`**: its own
`test/jest-e2e.json` config, run only via **`pnpm test:e2e`**, with Docker + real Postgres/Redis as
preconditions. `pnpm test` stays mock-only, fast, and key-free; CI's PR gate keeps running the unit
suite, and adds the **deterministic** e2e path (with the `postgres`/`redis` services the deploy spec
anticipates) — never the real-LLM path.

## Consequences

- ✅ The **wiring** the unit mocks skip — auth → `200`-fast enqueue → dedupe → resolution → serial
  dispatch → held/re-drive terminal branches → outbound — is finally exercised against a **real DB,
  real Redis, and the real queue boundary**, closing the tracked e2e gap.
- ✅ CI stays **deterministic, free, and key-less**: the scripted connector makes the gating
  assertions exact and repeatable, so a red e2e run means a real regression, not model variance.
- ✅ The capturing fake lets tests assert **what the engine decided to say / which keyboard it
  offered** without a bot token or any outbound network.
- ✅ Awaiting via `QueueEvents` / `waitUntilFinished` tests the **genuine** async two-phase
  boundary (no fixed `sleep`, no flaky poll), so the harness fails honestly if the consumer wiring
  regresses.
- ✅ The opt-in real-LLM mode gives a **truly-real** smoke signal on demand — schema-valid tool
  calls, real `stop_reason`s, real cache behaviour — that a scripted connector can never prove.
- ✅ Both modes sit behind the `ai.types.ts` boundary ([ADR 0007](0007-provider-connector-abstraction.md)),
  so the engine runs **identical code** in unit, scripted-e2e, and real-LLM — no test-only branches
  in production paths.
- ⚠️ The e2e suite **needs Docker** (Postgres + Redis up); it cannot run in a bare environment the
  way `pnpm test` can. CI must stand up the service containers, and a contributor must
  `docker compose -f docker-compose.dev.yml up -d` before `pnpm test:e2e`.
- ⚠️ The **real-LLM mode is non-deterministic and costs money**, so it is **opt-in and non-gating**
  by construction — it can only assert loose invariants, never exact behaviour, and it will not
  catch a precise-output regression. That precision is the scripted connector's job; the two modes
  are complementary, not interchangeable.
- ⚠️ The scripted connector is a **maintained fixture**: a real change to the prompt/tool contract
  that legitimately alters the model's expected output means updating scripts — the cost of making
  the gating path deterministic.
- ⚠️ A second Jest config + a Docker precondition is **more setup surface** than a single
  mock-only suite; mitigated by reusing the existing `test:e2e` script and `docker-compose.dev.yml`.

## Alternatives considered

### Call `AssistantService.handleText` directly, bypassing HTTP + the queue

Skip `supertest` and the BullMQ consumer; construct the orchestrator and invoke `handleText`
in-process. Tidier and synchronous — no `QueueEvents`, no Docker-Redis. **Rejected: it is not a
"real request."** The whole point is to exercise the parts the unit suite already mocks — the
secret-token auth, the `200`-fast enqueue, the Redis dedupe guard, and the **two-phase consumer
boundary** ([ai-workflow §1–2](../specs/ai-workflow.md#1-end-to-end-flow)). A direct `handleText`
call re-mocks exactly the wiring this harness exists to test, so it would pass while the controller,
queue registration, or consumer dedupe silently regressed. This is the unit suite's altitude, not
the e2e suite's.

### Make the **real-LLM** call the gating assertion

Run the real Anthropic connector in CI and assert on its output as the pass/fail gate. Most
"realistic." **Rejected as flaky and expensive.** The LLM is non-deterministic — the same prompt can
emit different text, a different number of `tool_use` blocks, or a different `stop_reason` run to
run — so any exact assertion is intermittently red for no real defect, and a CI that cries wolf gets
ignored. It also spends money and an `ANTHROPIC_API_KEY` on **every push**, and couples the merge
gate to provider availability / rate limits. The deterministic scripted connector gives exact,
free, repeatable gating; the real-LLM path is kept as an **opt-in, non-gating, loose-invariant**
smoke check — the realism without the flakiness on the merge path.

### One mode only — either scripted **or** real-LLM

Ship just the scripted connector (fully deterministic, but never proves a real model round-trip
survives the loop), **or** just the real connector (real, but flaky + costly + only loose
assertions). **Rejected as a false choice.** They answer different questions: scripted = "does the
**engine** do the exact right thing given a known model output" (the gate); real = "does a
**genuinely real** model round-trip flow through the loop without throwing" (the smoke signal).
Keeping both, with only the scripted one gating, gets precise CI *and* an on-demand realism check.

### Fold the e2e tests into `pnpm test`

One suite, one command. **Rejected** — it would force Docker + Postgres + Redis (and risk a stray
real-LLM key) onto every `pnpm test` run, destroying the fast, mock-only, key-free unit loop the
27 specs depend on. A separate `test/jest-e2e.json` / `pnpm test:e2e` keeps the fast inner loop fast
and lets CI run the heavyweight suite as its own gated job.

### `await` a fixed `sleep` after the webhook `POST`

Simplest way to "wait for the async turn." **Rejected as inherently flaky** — too short and the DB
assertion races the consumer; too long and every e2e test pays the slack. BullMQ already emits a
completion signal; `job.waitUntilFinished(queueEvents)` with a bounded timeout waits **exactly** as
long as the turn takes and fails fast if it never completes.

## References

- The pipeline under test (two-phase webhook → queue → loop → DB): [ai-workflow §1–2](../specs/ai-workflow.md#1-end-to-end-flow), §6, [§9](../specs/ai-workflow.md#9-held-conflict-confirmation-adr-0006-layer-4)
- Provider-neutral connector boundary the two AI modes plug into: [ADR 0007](0007-provider-connector-abstraction.md)
- Engine invariants the loose real-LLM assertions lean on: success-integrity guard [ai-workflow §10](../specs/ai-workflow.md#10-success-integrity-guard-the-trick-that-catches-lies); return-never-throw / `attempts:1` [§11](../specs/ai-workflow.md#11-retries--resilience--every-layer)
- Behaviours the scripted connector asserts precisely: re-drive [ADR 0009](0009-assistant-narration-redrive.md), neutral tool choice [ADR 0019](0019-assistant-neutral-ai-tool-choice.md), batch create/hold [ADR 0020](0020-assistant-batch-create-tasks.md)
- Where the CI services land (`postgres`/`redis` for `test:e2e`): [deployment-and-cicd §CI](../specs/deployment-and-cicd.md#components)
- Test/runtime assets: `test/jest-e2e.json` · `docker-compose.dev.yml` · `supertest` + `bullmq` (`QueueEvents` / `waitUntilFinished`) · scripts `pnpm test` (unit) / `pnpm test:e2e`
