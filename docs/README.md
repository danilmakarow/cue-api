# Cue API — docs/

This directory is the source of truth for **intent and decisions**.
The code is the source of truth for **behavior**.

## Layout

- **`architecture.md`** — one-page system overview. The 10,000-ft view a new contributor reads on day one. Updated rarely.
- **`adr/`** — Architecture Decision Records. One file per decision. Immutable once accepted; supersede with a new ADR rather than editing in place.
- **`specs/`** — Design docs. One file per significant feature or system. Written *before* a non-trivial implementation, updated as the design evolves, archived when superseded.
- **`tasks/`** — Implementation work items (stories) broken out of a spec when it's ready to build. See [`tasks/`](tasks/).
- **`api/openapi.yaml`** — Machine-readable HTTP contract. The bridge to [cue-ios](../../cue-ios/). Source of truth for endpoints, request/response shapes, and status codes.

## When to write what

| Situation | Artifact |
|---|---|
| Architectural decision (DB choice, transport, schema convention) | New [`adr/NNNN-*.md`](adr/) |
| Designing a new feature or non-trivial subsystem | New [`specs/<feature>.md`](specs/) **before** coding |
| Breaking a ready spec into buildable stories | New `tasks/<feature>-N-*.md` (see [`tasks/`](tasks/)) |
| Adding/changing an HTTP endpoint | Update [`api/openapi.yaml`](api/openapi.yaml) in the same PR |
| Onboarding context that's neither a decision nor a feature | Update [`architecture.md`](architecture.md) |
| One-off note for *one* PR | The PR description — not a doc |

## How to write each kind

- **ADRs**: copy [`adr/TEMPLATE.md`](adr/TEMPLATE.md). Number sequentially (`0003-...`, `0004-...`). Title in kebab-case. State the decision and *why this not that*. Aim for one screen.
- **Specs**: copy [`specs/TEMPLATE.md`](specs/TEMPLATE.md). Lead with **Context → Goals → Non-goals**. Spend more time on **Alternatives considered** than on the chosen design. Mark **Open questions** explicitly.
- **OpenAPI**: hand-written for now; once endpoints stabilize, switch to `@nestjs/swagger` decorator-generated and commit the output.

## Rules of the road

- **Living documents.** If code drifts from a spec, update the spec or write an ADR that supersedes it.
- **Short over long.** If a spec grows past ~2 screens, split it.
- **Diagrams inline as Mermaid.** No external image files unless Mermaid cannot express it.
- **Link liberally** between docs with relative paths.
- **The ADR log is append-only.** To overturn a past decision, write a new ADR that references and supersedes it; do not edit the original.
