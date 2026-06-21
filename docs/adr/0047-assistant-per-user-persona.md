# 0047 — assistant-per-user-persona

- **Status**: Accepted
- **Date**: 2026-06-21
- **Deciders**: @danil

## Context

v2 Story 18 ships the per-user AI personality designed in
[ADR 0014](0014-assistant-per-user-personality.md): each user can adopt their own
persona, with a seeded out-of-box "Jarvis" preset as the default. This ADR records
the **implementation** — the entity shape, the REST surface, and (the load-bearing
part) the **cache-correct prompt injection** under
[ADR 0004](0004-assistant-prompt-composition-and-caching.md).

Two constraints bind the implementation:

1. **The shared cross-user cached prefix must stay byte-stable.** Tools precede
   `system` in the provider prefix, so the system prompt up to **breakpoint #1**
   (`context-builder.service.ts`) is the prefix every user shares and hits every
   turn. A per-user string placed in block 1 cold-starts the persona **and** the
   tool definitions for every user, every turn — the exact regression ADR 0004
   exists to prevent.
2. **The cache-bug AC is DROPPED (Corrected Assumption 1).** The retired research's
   claim that tool definitions are billed at full price every turn "because no
   `ToolSchema` sets `cacheBoundary`" is a **misdiagnosis**: tools are already
   covered by breakpoint #1 (they precede `system`). Story 18 therefore adds **no**
   tools `cacheBoundary` and changes block 1 in no way.

## Decision

We add a **`PersonaPrompt`** entity, a REST settings surface, and a single
cache-correct prompt block.

### Entity + persistence

`PersonaPrompt` (`src/modules/database/entities/persona-prompt.entity.ts`) carries
`userId` (nullable), `presetName` (nullable), `promptText` (`text`), and a `source`
enum (`preset` | `custom`). Two row shapes share the table:

- a **`PRESET`** row (`userId = null`, `presetName` set) is a curated, user-agnostic
  persona seeded once — the out-of-box **"Jarvis"** (a dry, formal English-butler
  persona). One seeded row is enough for now (no preset-management UI).
- a **`CUSTOM`** row (`userId` set) is a user's own active persona.

A **partial unique index** on `userId WHERE userId IS NOT NULL` enforces at most one
custom persona per user while leaving preset rows (all-null) unconstrained. The
migration (`1783100000000-add-persona-prompt.ts`) creates the table and **seeds the
Jarvis preset**. Access flows through the strict 3-layer path
(`PersonaPromptRepository` → `PersonaPromptDatabaseService`, registered in
`DatabaseModule`); writes go through `.save()` with a no-op short-circuit.

### REST

**`GET`/`PATCH /users/me/persona-settings`** behind `AccessTokenGuard`
(`src/modules/persona/`, mirroring the Story-17 report-settings controller). `GET`
resolves the active persona — the user's `CUSTOM` row, else the seeded preset, else
a code-constant default — so it **always returns the Jarvis default when unset**.
`PATCH` validates `promptText` as non-empty (trimmed) and length-bounded
(1–2000 chars) and upserts the user's `CUSTOM` row. `openapi.yaml` is updated in the
same change. Telegram exposes no config — settings are REST/iOS only.

### Cache-correct injection (the critical part)

The active persona text is injected as **one prompt block in the per-user stable
region** — positioned **AFTER the profile/groups blocks and BEFORE the rolling
summary**, with **NO `cacheBoundary` of its own**. The per-user region is closed by
the summary's **breakpoint #2**, so the persona is naturally covered by that
per-user cache without ever touching block 1.

- **Breakpoint #1 stays byte-stable across users.** The shared system prompt + tool
  defs are unchanged; the persona lives strictly below #1. A cross-user
  cache-stability test asserts two **different** users' prompts share a
  byte-identical breakpoint-#1 prefix (cacheBoundary flags and all) while only the
  per-user region differs — proving the persona did not leak into the shared prefix.
- **No tools `cacheBoundary` was added** (Corrected Assumption 1). The dead
  `ToolSchema.cacheBoundary` path (`ai.types.ts`, the connector) is left untouched;
  it is unused dead code, not a cost leak, and touching it risks the byte-stable
  prefix for no benefit.
- The persona text is **resolved before assembly and always present** (custom →
  seeded preset → code-constant Jarvis), so the block is byte-stable for a given
  persona and the prompt never depends on the seed having run.

## Consequences

- ✅ Per-user personality **without** nuking the shared block-1 cache — the persona
  joins the already-per-user breakpoint-#2 region.
- ✅ A clean dedicated entity (vs overloading `UserMemoryFact`) with a seeded preset.
- ✅ The cross-user cache-stability test makes the placement rule **executable**, not
  just documented — a future regression that lifts the persona into block 1 fails CI.
- ⚠️ A persona change invalidates **that user's** breakpoint-#2 cache until the next
  summary rewrite — acceptable (per-user, infrequent).
- ⚠️ One seeded preset, no curation UI — a deliberate future feature.
- ⚠️ The code-constant default text and the seed migration's inlined copy are kept in
  sync by hand (migrations stay self-contained snapshots). There is exactly one
  **runtime** source (`persona.constants.ts`); the migration copy is a one-time seed.

## Alternatives considered

### Put the persona in block 1 (alongside the shared system prompt)

Rejected — it destroys the cross-user shared prefix, the entire point of ADR 0004.
This is the regression the cross-user cache-stability test guards against.

### Wire a tools `cacheBoundary` to "fix" the cache bug

Rejected — there is no bug (Corrected Assumption 1). Tools precede `system`, so they
are already cached by breakpoint #1. Adding a redundant boundary changes the prefix
for no gain and re-introduces a dropped AC.

### Store the persona as a `UserMemoryFact`

Rejected — it overloads a semantic memory store (subject to extractor noise) with a
settings value; a dedicated entity with explicit semantics is cleaner.

### Code-constant default only (no DB row)

Rejected **for the preset** — a seeded "Jarvis" row lets users browse and pick
presets later. The code constant remains the last-resort fallback (and the
context-builder's byte-stability guarantee) when nothing is set and the seed is
absent.

## References

- The design this implements: [ADR 0014](0014-assistant-per-user-personality.md)
- The caching constraint: [ADR 0004](0004-assistant-prompt-composition-and-caching.md)
- Plan + the dropped cache-bug AC: [ai-workflow v2 plan — Story 18 + Corrected Assumption 1](../specs/ai-workflow-v2-plan.md)
- Entity / repo / DB service: `src/modules/database/entities/persona-prompt.entity.ts`,
  `src/modules/database/services/persona-prompt-database.service.ts`
- REST: `src/modules/persona/persona-settings.controller.ts`
- Injection + cross-user cache-stability test: `src/modules/assistant/context-builder.service.ts`,
  `src/modules/assistant/context-builder.service.spec.ts`
- HTTP contract: [`openapi.yaml`](../api/openapi.yaml) → `/users/me/persona-settings`
