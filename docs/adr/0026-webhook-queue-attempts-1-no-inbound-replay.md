# 0026 — webhook-queue-attempts-1-no-inbound-replay

- **Status**: Accepted
- **Date**: 2026-06-20
- **Deciders**: @danil

## Context

The inbound Telegram webhook is processed off the request path by a BullMQ queue (`WEBHOOK_QUEUE_NAME`): the controller 200s Telegram immediately and enqueues the raw update; `WebhookConsumer.process()` runs the full pipeline (normalize → Redis dedupe → resolve user → STT → orchestrator → calendar writes).

**The inbound pipeline is non-idempotent.** A turn can commit `create_task` / `create_tasks` writes mid-flight and then throw afterwards (e.g. a later Telegram send fails). If BullMQ re-drives that job, the committed writes run **again** → double-booking. The whole "every terminal path returns, never throws" invariant ([ADR 0009](0009-assistant-narration-redrive.md), [ADR 0016](0016-assistant-ai-comms-audit-hardening.md)) exists precisely because a replay is unsafe: the consumer rethrows **only** to release its Redis dedupe guard, never to request a retry.

The global `BullModule.forRootAsync` `defaultJobOptions` in `src/app.module.ts` is `attempts: 5` + exponential backoff — a sensible default for ordinary, idempotent future queues (e.g. a planned `assistant-background` worker). That default is wrong for the inbound webhook queue, which must run each job **exactly once**.

**Correction (honest record).** [ADR 0018](0018-assistant-ai-comms-phase-b-scope-refinement.md) (Consequences, line 41) stated the global `defaultJobOptions` had been *reverted to `attempts: 1`* as a double-write hazard fix, and [ADR 0009](0009-assistant-narration-redrive.md) / [ADR 0016](0016-assistant-ai-comms-audit-hardening.md) built their "no-throw / return-never-throw" reasoning on the premise that *"the queue is already `attempts: 1`"*. **That premise was inaccurate.** A prior consolidation run *reported* reverting the global to `1`, but the change did not persist — the committed `src/app.module.ts` was still `attempts: 5` + backoff. So between then and this ADR, a thrown inbound turn would in fact have **replayed up to 5×**, contradicting those ADRs' stated invariant. This ADR makes the `attempts: 1` guarantee real for the webhook queue, via a per-queue + per-job override rather than by mutating the global. Per the immutable-ADR convention, this ADR **supersedes that premise** in ADR-0016/0018's consequences rather than editing those files in place.

## Decision

The inbound webhook BullMQ queue runs with **`attempts: 1`** — a thrown job is **not** replayed. The global `defaultJobOptions` stays `attempts: 5` + exponential backoff for every other / future queue; the override is applied to the webhook queue **only**, at two layers:

1. **Per-queue** — `BullModule.registerQueue({ name: WEBHOOK_QUEUE_NAME, defaultJobOptions: { attempts: 1 } })` in `src/modules/assistant/assistant.module.ts`. `removeOnComplete` (true) / `removeOnFail` (false) intentionally inherit the global, so a failed job is still retained for inspection.
2. **Per-job (guaranteed override)** — the controller passes `attempts: 1` on the enqueue: `webhookQueue.add('inbound', job, { jobId, attempts: 1 })` in `src/modules/assistant/assistant-webhook.controller.ts:110`.

BullMQ merges job options most-specific-wins (connection `defaultJobOptions` → `registerQueue` `defaultJobOptions` → per-`add()` options), so either layer beats the global; both are set so the guarantee does not ride on a single mechanism (`@nestjs/bullmq@11` / `bullmq@5`). No `backoff` is meaningful at a single attempt.

## Consequences

- ✅ **No inbound double-booking.** A thrown turn that already committed `create_task` / `create_tasks` writes fails terminally instead of replaying and re-running those writes.
- ✅ **The "return-never-throw" invariant is now actually backed by config.** ADR-0009/0016's reasoning ("every terminal path returns, never throws — because the queue is `attempts:1`") is, from this ADR onward, a true statement about the webhook queue rather than an aspiration.
- ✅ **Other / future queues keep sane retries.** The global `attempts: 5` + backoff still applies to any queue that does not override it — a future idempotent `assistant-background` worker can retry transient failures without touching this decision.
- ✅ **Defense in depth.** Per-queue *and* per-job override means the guarantee survives a refactor that drops either one.
- ✅ **Failed jobs remain inspectable.** `removeOnFail: false` is inherited, and `WebhookConsumer.onFailed` logs the terminal failure — a failed update is never silently dropped.
- ⚠️ **A transient inbound failure is now dropped, not retried.** If a turn throws on a genuinely transient error (e.g. a momentary DB blip) *after* committing nothing, that update is lost rather than retried — the user must resend. This is the accepted cost: retrying a non-idempotent turn double-books, which is worse than dropping one. Making inbound retryable would require **idempotent writes** (e.g. an idempotency key on `create_task[s]`), a separate effort tracked outside this ADR.
- ⚠️ **The override must be carried by whoever registers the queue.** If the webhook queue is ever re-registered elsewhere without the per-queue `defaultJobOptions`, it silently inherits `attempts: 5` again — the per-job `attempts: 1` at the controller is the backstop, and both should be kept.

## Alternatives considered

### Set the global `defaultJobOptions` to `attempts: 1`

This is what a prior run *reported* doing (see the Correction note). Rejected: it makes **every** queue non-retrying, including future idempotent workers (`assistant-background`, notification fan-out) that legitimately *want* `attempts: 5` + backoff for transient failures. The global is the right place for the common-case default; the webhook queue is the exception and should declare itself the exception. Mutating the global to fix one queue is the inversion of where the constraint actually lives.

### Per-queue `defaultJobOptions` only (no per-job override)

Rejected as the *sole* mechanism — not because it is wrong (`registerQueue` `defaultJobOptions` does override the connection default in `bullmq@5`), but because the guarantee is safety-critical and should not ride on a single config line that a future refactor could drop. The per-job `attempts: 1` is the guaranteed, most-specific override; the per-queue default documents the intent at the registration site. Both, not either.

### Keep `attempts: 5` and convert every terminal throw to `UnrecoverableError`

Rejected — fragile and inverts the default. It would require *every* current and future terminal path in the pipeline to remember to wrap in `UnrecoverableError`; a single missed throw replays and double-books. `attempts: 1` makes "do not replay" the structural default instead of a per-throw obligation. (ADR-0009/0016 already note this `UnrecoverableError` path as the thing you'd be forced into if attempts were ever raised — this ADR keeps us out of it.)

### Make the inbound pipeline idempotent, then allow retries

The principled long-term fix, but out of scope here. It requires an idempotency key threaded through `create_task` / `create_tasks` (and the dedupe guard) so a replayed commit is a no-op. Worth doing if transient-failure loss becomes a real problem; until then, `attempts: 1` is the correct, cheap guarantee.

## References

- The non-idempotent-replay hazard + return-never-throw invariant: [ADR 0009](0009-assistant-narration-redrive.md), [ADR 0016](0016-assistant-ai-comms-audit-hardening.md)
- The (inaccurate) "global reverted to attempts:1" premise this ADR supersedes: [ADR 0018](0018-assistant-ai-comms-phase-b-scope-refinement.md) Consequences
- The queue retry row: [ai-workflow §11](../specs/ai-workflow.md#11-retries--resilience--every-layer)
- Global default: `src/app.module.ts` · Per-queue override: `src/modules/assistant/assistant.module.ts` · Per-job override: `src/modules/assistant/assistant-webhook.controller.ts:110` · Consumer behavior: `src/modules/assistant/webhook.consumer.ts`
