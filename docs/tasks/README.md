# Cue API — docs/tasks/

Implementation **work items** — buildable stories broken out of a `specs/` design doc.
A spec answers *what and why*; a task answers *what to build next, and when it's done*.

## Format

Each task follows: **Story → Context / Why now → Acceptance Criteria → Out of scope → Technical notes → Dependencies / Risks**, ending with the Definition of Ready / Definition of Done pointer. Acceptance criteria are written so they can be checked off and tested.

## When to write one

Break a non-trivial [spec](../specs/) into tasks when it's ready to build and the work splits into independently reviewable chunks. Keep the spec as the single source of design truth; tasks link **up** to it rather than restating it.

## Current task sets

### Telegram AI assistant — design: [specs/telegram-ai-assistant.md](../specs/telegram-ai-assistant.md)

Connectors (1, 2, 4) are independent and build first; the wiring (3) depends on all three.

1. [External vendor connector](./ai-assistant-1-external-vendor-connector.md) — vendor-agnostic inbound/outbound messaging; Telegram impl over webhooks.
2. [AI connector](./ai-assistant-2-ai-connector.md) — provider-agnostic LLM access (tool use, caching, model roles); Anthropic impl.
3. [Application wiring](./ai-assistant-3-application-wiring.md) — the `assistant` module, entities + migration, endpoints, Redis, env; consumes connectors 1, 2, and 4.
4. [STT connector](./ai-assistant-4-stt-connector.md) — provider-agnostic speech-to-text; OpenAI impl (transcribes voice notes). A connector peer of 1–2.
