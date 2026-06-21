# 0023 — assistant-529-fallback-model

- **Status**: Accepted
- **Date**: 2026-06-20
- **Deciders**: @danil

## Context

The Anthropic SDK already retries the **main** model on transport failures (exp backoff + jitter + `Retry-After` + 408/409/429/≥500), bounded by `ASSISTANT_AI_MAX_RETRIES` (see [ai-workflow §11](../specs/ai-workflow.md#11-retries--resilience--every-layer)). But a **529 / `overloaded_error`** is an Anthropic-side capacity signal: retrying the *same* model under sustained overload just burns the retry budget and then degrades to `AI_FAILURE_REPLY`. Under the queue's `attempts: 1` posture a degraded turn is a **dead turn** — the user gets "try again in a moment" and the obligation is dropped for that inbound.

[ADR 0018](0018-assistant-ai-comms-phase-b-scope-refinement.md) deferred this (Story 3b) as marginal-at-personal-scale and recorded the revisit trigger: *real post-retry 529s in logs*. [ADR 0022](0022-deferred-ai-comms-stories-execution-plan.md) now authorizes it as **Wave 1**. The [ai-comms audit §B](../specs/ai-comms-cc-audit.md) flagged it as the single highest-value failure-handling item once we commit to closing the deferred set, because it is the only thing standing between a sustained main-model overload and a dropped turn.

We already run a **BACKGROUND** role (Haiku — used for summaries + extraction; [ai-workflow §12](../specs/ai-workflow.md#12-model-roles--connector-abstraction-adr-0003--0007)), so a fallback model id is already configured. We do **not** need a new required env var.

## Decision

On a **sustained 529 / overload of the MAIN model** — i.e. *after* the SDK's built-in retries are exhausted — the connector **retries the turn once on the BACKGROUND (Haiku) model id** as the fallback. The fallback **degrades-never-throws**: if Haiku also fails, the connector returns today's terminal `AI_FAILURE_REPLY` rather than throwing (upholding the `attempts: 1` return-never-throw invariant).

Specifics:

- **Only the MAIN role gets a fallback.** A BACKGROUND call has nowhere sensible to fall back *to* (Haiku is already the cheap tier), so background overload degrades as today.
- **No new required env var.** The fallback target reuses the already-configured `ASSISTANT_MODEL_BACKGROUND`. No `ASSISTANT_FALLBACK_MODEL` is introduced.
- **529 detection is centralized in one exported `is529()` helper:** true when `status === 529` **OR** the response body contains the substring `"overloaded_error"` (the SDK can drop the numeric status mid-stream, so the status alone is unreliable). This single helper is consumed by **both** the fallback decision and `describeAnthropicError`.
- The fallback sits **above** the SDK's own retries — it triggers only when those are exhausted, so it is a last resort, not a per-attempt swap.

## Consequences

- ✅ A sustained main-model overload no longer means a dead turn — Haiku takes the turn and the user gets a real answer instead of "try again."
- ✅ **Zero new config surface** — reuses the existing BACKGROUND model id; nothing to set, nothing to forget in `ssm.tf` / `.env.example`.
- ✅ One `is529()` helper means the fallback path and the error-description path agree on what "overloaded" means; the status-dropped-mid-stream case is handled in one place with a focused unit spec (status-529 · status-dropped-body-string · neither).
- ⚠️ **Honest downside: Haiku may make weaker tool decisions than Sonnet** — a fallback turn could choose a less-apt tool or a clumsier plan. We accept this: a weaker-but-completed turn beats a dropped one, and the fallback only fires under genuine sustained overload (a rare event at personal scale).
- ⚠️ The fallback is bounded to **one** retry on Haiku. If Haiku is *also* overloaded, we degrade to `AI_FAILURE_REPLY` — no infinite or multi-model cascade.
- ⚠️ A wrong write under a weaker model is still possible; this is the same risk ADR 0018 flagged ("a wrong write is worse than a deferred one"). It is bounded because the fallback is rare and the existing success-integrity guard + re-drive (ADR 0009) still apply to the fallback turn.

## Alternatives considered

### Keep retrying the same (MAIN) model only — no fallback

Rejected — that is today's behaviour, and under `attempts: 1` it degrades a sustained overload to a dropped turn. The whole point of Story 3b is that the SDK's same-model retry has no answer to capacity exhaustion.

### Introduce a dedicated `ASSISTANT_FALLBACK_MODEL` env var

Rejected — adds required config surface (Zod schema + `ssm.tf` + `.env.example`) for no gain. The BACKGROUND model id is already configured and is exactly the cheaper, more-available tier we want as a fallback. Reusing it keeps the change additive and zero-config.

### Give the BACKGROUND role a fallback too

Rejected — Haiku is already the cheap/available tier; there is no sensible cheaper model to fall back to, and background failures (summary/extract) are non-blocking and already degrade gracefully. Scoping the fallback to MAIN keeps it simple and targeted.

### Detect 529 by HTTP status alone

Rejected — the SDK can drop the numeric status mid-stream, so a status-only check misses real overloads. Matching `status === 529` **OR** the `"overloaded_error"` body substring (via the shared `is529()` helper) catches both shapes.

## References

- The execution plan that authorizes this as Wave 1: [ADR 0022](0022-deferred-ai-comms-stories-execution-plan.md)
- The deferral + revisit trigger this closes: [ADR 0018](0018-assistant-ai-comms-phase-b-scope-refinement.md) ("On 529 → fallback (Story 3b) being marginal")
- Story 3b (shipped) as-built: [ai-workflow](../specs/ai-workflow.md)
- The retry layers this sits above: [ai-workflow §11](../specs/ai-workflow.md#11-retries--resilience--every-layer) · model roles: [ai-workflow §12](../specs/ai-workflow.md#12-model-roles--connector-abstraction-adr-0003--0007)
- Connector abstraction: [ADR 0007](0007-provider-connector-abstraction.md) · model roles: [ADR 0003](0003-assistant-llm-provider-anthropic.md)
