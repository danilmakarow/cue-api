# 0014 — assistant-per-user-personality

- **Status**: Accepted
- **Date**: 2026-06-19
- **Deciders**: @danil

## Context

The assistant's persona (the J.A.R.V.I.S. text in `assistant.prompts.ts`) is a single **compile-time constant** injected as **system block 1 with `cacheBoundary: true`** — **byte-identical for every user**, the shared cross-user cache prefix that all users hit every turn ([ADR 0004](0004-assistant-prompt-composition-and-caching.md)).

v2 wants a **per-user personality** attached to every session. The caching constraint is the whole problem: moving a per-user string into **block 1 destroys the cross-user cache** (every user cold-starts the persona *and* the tool definitions every turn). A **per-user stable region already exists between cache breakpoints #1 and #2** (the profile / groups blocks), which is cached by breakpoint #2 and stays warm until the rolling summary is rewritten.

The product owner chose: a **default** persona plus a **seeded "Jarvis" preset** in the DB; the user picks a preset or writes their own; **one seeded row is enough for now** (no preset-management UI).

## Decision

We add a **`PersonaPrompt` entity** (`userId` FK, `promptText`, `source` enum, `updatedAt`) with a **seeded "Jarvis" preset** row, and expose **`GET`/`PATCH /users/me/persona-settings`** (the iOS app owns the screen). The active per-user persona is injected as a prompt block **between the profile/groups blocks and the rolling summary, with NO `cacheBoundary`** — inside the per-user region closed by breakpoint #2. **Block 1 (the shared system prompt + tool definitions) is untouched.** When no persona is set, we fall back to the existing Jarvis text. We also **fix the latent caching bug** surfaced during recon: `tool-schemas.ts` comments that the last schema "carries `cacheBoundary`", but **no `ToolSchema` actually sets it**, so the tool definitions may be billed at full input price every turn — one schema must actually set it.

## Consequences

- ✅ Per-user personality **without** nuking the shared block-1 cache — the persona joins the already-per-user breakpoint-#2 region.
- ✅ A clean, dedicated entity (vs overloading `UserMemoryFact`) with a seeded preset users can pick.
- ✅ Fixes a real per-turn cost leak (tool definitions become actually cacheable).
- ⚠️ A persona change invalidates **that user's** breakpoint-#2 cache until the next summary rewrite — acceptable (per-user, infrequent).
- ⚠️ A naive insert into block 1 would regress the **cross-user** cache — the placement rule is load-bearing and must be enforced in review.
- ⚠️ No preset curation/management yet (one seeded row) — a deliberate future feature.

## Alternatives considered

### Put the persona in block 1 (alongside the shared system prompt)

Rejected — it destroys the cross-user shared prefix, which is the entire point of [ADR 0004](0004-assistant-prompt-composition-and-caching.md).

### Store the persona as a `UserMemoryFact`

Rejected — it overloads a semantic memory store with a settings value and is subject to extractor noise; a dedicated entity with explicit semantics is cleaner.

### Code-constant default only (no DB row)

Rejected **for the preset** — a seeded "Jarvis" row lets users browse and pick presets later; the code constant remains the fallback default when a user has set nothing.

## References

- The caching design this must respect: [ADR 0004](0004-assistant-prompt-composition-and-caching.md)
- Research: [ai-workflow-v2-research §G](../specs/ai-workflow-v2-research.md) · design: [ai-workflow-tasks Story 18](../specs/ai-workflow-tasks.md)
</content>
