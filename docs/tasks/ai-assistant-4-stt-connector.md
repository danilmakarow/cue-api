# AI assistant — Task 4: Speech-to-text (STT) connector

- **Status**: Draft (design pending sign-off — the spec is still Draft)
- **Owner**: @danil
- **Build order**: a **connector peer of [Tasks 1](./ai-assistant-1-external-vendor-connector.md)–[2](./ai-assistant-2-ai-connector.md)** — build before [Task 3](./ai-assistant-3-application-wiring.md), which consumes it
- **Design**: [telegram-ai-assistant spec](../specs/telegram-ai-assistant.md) · ADRs [0007 — provider-connector-abstraction](../adr/0007-provider-connector-abstraction.md) (the pattern) · [0003](../adr/0003-assistant-llm-provider-anthropic.md) (provider-pick precedent)

## Story

As a Cue backend engineer, I want speech-to-text behind a provider-agnostic connector with an OpenAI implementation, so that the assistant can transcribe Telegram voice notes on OpenAI today and swap the STT provider later without touching the pipeline.

## Context / Why now

Voice notes are a first-class input ([spec](../specs/telegram-ai-assistant.md)); the [inbound pipeline](../specs/telegram-ai-assistant.md#inbound-pipeline-every-telegram-update) has a transcription seam ([Task 3](./ai-assistant-3-application-wiring.md)) but no provider behind it. We pick **OpenAI** transcription for v1 and model it as a connector per [ADR 0007](../adr/0007-provider-connector-abstraction.md) so it stays swappable — the researched alternatives (Groq `whisper-large-v3-turbo`, Deepgram Nova-3) sit behind the same factory. The vendor connector ([Task 1](./ai-assistant-1-external-vendor-connector.md)) already returns the raw audio bytes; this task turns them into text. This realizes ADR 0007's own list of "future connectors (… STT …)".

## Acceptance Criteria

- [ ] An abstract `SttConnector` contract defines `transcribe(audio, options)` returning a normalized `TranscriptionResult` (text + detected language + optional duration/usage), plus a declared `capabilities` set.
- [ ] An `SttConnectorFactory` resolves the active provider from config (`STT_PROVIDER`), exposes `getActive()` + `get(provider)`, and **fails fast at startup** on an unknown/unconfigured provider.
- [ ] `OpenAiSttConnector` implements the contract over the official `openai` SDK, transcribing via `gpt-4o-mini-transcribe` by default (model configurable — e.g. `gpt-4o-transcribe` for higher accuracy).
- [ ] Given a Telegram **OGG/Opus** voice note, when transcribed via OpenAI, then the connector **transcodes** it to a supported format (e.g. 16 kHz mono WAV) before upload — because the OpenAI endpoint does **not** accept OGG/Opus — and returns the transcript. (Native-OGG providers skip this; the transcode lives in the OpenAI impl, not the abstraction.)
- [ ] Transcription is returned in the **source language** by default; translate-to-English happens only when `options.translateToEnglish` is set (capability-gated).
- [ ] Given audio exceeding the provider limit (OpenAI: 25 MB), when submitted, then it is rejected with a typed error rather than a raw SDK failure. (Telegram voice notes are far below this; no chunking in v1.)
- [ ] Given a provider 429 / 5xx, when `transcribe` is called, then it retries with bounded backoff and surfaces a typed `SttUnavailableError` on exhaustion — which the consumer maps to the spec's "couldn't hear that, try again" reply.
- [ ] Capability flags (`translation`, `autoDetectLanguage`, `maxBytes`, `formats`) are declared so callers can branch (e.g. decide whether to transcode) without hardcoding provider quirks.
- [ ] **Boundary:** the connector only transcribes. Fetching the audio bytes is the vendor connector ([Task 1](./ai-assistant-1-external-vendor-connector.md) `fetchMedia`); persisting the transcript as a `voice_transcript` message and acting on it is the orchestrator ([Task 3](./ai-assistant-3-application-wiring.md)).
- [ ] Repo conventions: abstract class with real methods, enums in-file + re-exported, no `any`, JSDoc, Zod-validated config.

## Out of scope

- Fetching/downloading the audio — that's [Task 1](./ai-assistant-1-external-vendor-connector.md)'s `fetchMedia`.
- Wiring transcription into the pipeline and persisting the `voice_transcript` `ConversationMessage` — [Task 3](./ai-assistant-3-application-wiring.md) (this connector fills its STT seam).
- TTS / spoken replies — [spec non-goal](../specs/telegram-ai-assistant.md).
- Streaming / partial transcription — voice notes are complete files; batch only.
- Speaker diarization — 1:1 voice notes don't need it.
- Keeping the raw audio after transcription — leaning transcript-only ([spec open question](../specs/telegram-ai-assistant.md#open-questions)).

## Technical notes

**Location.** New top-level module `src/modules/stt/` — the third [ADR 0007](../adr/0007-provider-connector-abstraction.md) connector alongside `external-vendor` and `ai`.

**Structure** (the [ADR 0007](../adr/0007-provider-connector-abstraction.md) pattern again — abstract base + capabilities + config + factory + impl):

```
src/modules/stt/
  stt.types.ts                 ← enums + normalized DTOs
  stt-connector.abstract.ts
  stt.config.ts                ← typed config from env
  stt-connector.factory.ts
  openai/
    openai-stt.connector.ts    ← official `openai` SDK; transcode + transcribe
  stt.module.ts                ← registers connectors + factory; exports factory + an ACTIVE_STT_CONNECTOR token
```

**The contract** (illustrative sketch):

```ts
export abstract class SttConnector {
  abstract readonly provider: SttProvider;
  abstract readonly capabilities: SttCapabilities;

  /** Transcribe an audio payload to text (source language by default). */
  abstract transcribe(
    audio: MediaPayload,
    options?: TranscribeOptions,
  ): Promise<TranscriptionResult>;
}
```

**Data shapes** (`stt.types.ts`): `SttProvider` enum (`OPENAI`); `TranscribeOptions { languageHint?, translateToEnglish?, prompt? }`; `TranscriptionResult { text, language?, durationSeconds?, usage? }`; `SttCapabilities { translation, autoDetectLanguage, maxBytes, formats }`. Reuses `MediaPayload { bytes, mimeType }` from the [external-vendor connector](./ai-assistant-1-external-vendor-connector.md) types.

**The factory.** Same shape as the other connectors: a Nest provider that resolves the concrete connector from `STT_PROVIDER` and binds an `ACTIVE_STT_CONNECTOR` token; `get(provider)` keeps Groq/Deepgram available as future drop-ins.

**OpenAI implementation specifics.**
- Endpoint `POST /v1/audio/transcriptions`, model `gpt-4o-mini-transcribe` (default) / `gpt-4o-transcribe`, via the official `openai` Node SDK (`client.audio.transcriptions.create`).
- **Format gotcha (the main integration cost):** OpenAI accepts mp3, mp4, mpeg, mpga, m4a, wav, webm — **not OGG/Opus**. Telegram voice notes are OGG/Opus, so the impl transcodes first (e.g. `ffmpeg-static` + `fluent-ffmpeg`: OGG/Opus → 16 kHz mono WAV). Native-OGG providers (Groq, Deepgram) would remove this step entirely.
- Translate-to-English via the translations endpoint (`whisper-1`) or a model instruction — **off by default** (we keep source-language transcripts; Claude is multilingual). Verify the exact translate path against current OpenAI docs at build time.
- 25 MB request limit; 99+ languages with auto-detect. Price: `gpt-4o-mini-transcribe` ≈ $0.003/min (effectively free at our volume).

**Configuration** (Zod → `ConfigService`, added in [Task 3](./ai-assistant-3-application-wiring.md)'s env work): `STT_PROVIDER` (enum, default `openai`), `OPENAI_API_KEY`, `STT_MODEL` (default `gpt-4o-mini-transcribe`), optional `STT_TRANSLATE_TO_ENGLISH` (default `false`).

**End-to-end.** [Task 1](./ai-assistant-1-external-vendor-connector.md) `fetchMedia` → `MediaPayload { bytes, mimeType: 'audio/ogg' }` → `stt.transcribe(payload)` → text → [Task 3](./ai-assistant-3-application-wiring.md) persists a `voice_transcript` `ConversationMessage` and feeds the text into the same pipeline as a typed message.

## Dependencies / Risks

- **Consumed by [Task 3](./ai-assistant-3-application-wiring.md); depends on [Task 1](./ai-assistant-1-external-vendor-connector.md)** for the audio bytes. Independent of [Task 2](./ai-assistant-2-ai-connector.md).
- New deps: the `openai` SDK + an ffmpeg path (`ffmpeg-static` / `fluent-ffmpeg`) for the OGG→WAV transcode. **The transcode + binary dependency is the main cost of choosing OpenAI** — Groq or Deepgram (native OGG) would remove it behind the same factory if the ffmpeg dep proves unwelcome (note the project's "vendor/own over deps" lean).
- Needs `OPENAI_API_KEY` — **separate** from the Anthropic key used by [Task 2](./ai-assistant-2-ai-connector.md).
- Privacy: audio leaves to OpenAI; default transcript-only retention ([spec open question](../specs/telegram-ai-assistant.md#open-questions)).
- The OpenAI provider pick mirrors [ADR 0003](../adr/0003-assistant-llm-provider-anthropic.md) (Anthropic for the LLM) and is ADR-worthy — consider pinning it in a short ADR so the decision and its alternatives are on the record.

> Definition of Ready & Definition of Done: see team wiki.
