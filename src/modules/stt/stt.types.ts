/**
 * Speech-to-text provider identifiers. The active provider is selected from the
 * `STT_PROVIDER` env var and resolved by the `SttConnectorFactory`. Only OpenAI
 * is implemented today; Groq / Deepgram remain future drop-ins behind the same
 * factory (ADR 0007).
 */
export enum SttProvider {
  OPENAI = 'openai',
}

/**
 * Per-call transcription options. All optional — the default behavior is to
 * transcribe in the source language with no prompt and no translation.
 */
export interface TranscribeOptions {
  /**
   * BCP-47 / ISO-639-1 language hint (e.g. `en`, `ru`). Improves accuracy and
   * latency when the spoken language is known up front. Ignored on the
   * translate path (translation output is always English).
   */
  languageHint?: string;
  /**
   * When `true`, translate the audio to English instead of transcribing in the
   * source language. Capability-gated via `SttCapabilities.translation`.
   */
  translateToEnglish?: boolean;
  /**
   * Optional text to bias the model's style or vocabulary (e.g. domain terms).
   * Should match the audio language.
   */
  prompt?: string;
}

/**
 * Normalized transcription result returned by every connector, independent of
 * the underlying provider. `language` and `durationSeconds` are best-effort:
 * not every provider/model reports them (e.g. OpenAI's `gpt-4o-*-transcribe`
 * models return only text), so consumers must treat them as optional.
 */
export interface TranscriptionResult {
  /** The transcribed (or translated) text. */
  text: string;
  /** Detected source language (provider-reported) when available. */
  language?: string;
  /** Audio duration in seconds when the provider reports it. */
  durationSeconds?: number;
  /** Best-effort provider usage stats (tokens / seconds) when available. */
  usage?: SttUsage;
}

/**
 * Best-effort usage accounting surfaced by the provider. Fields are optional
 * because providers report different units (audio seconds vs. tokens).
 */
export interface SttUsage {
  /** Billed audio seconds, when the provider reports duration-based usage. */
  seconds?: number;
  /** Input tokens, when the provider reports token-based usage. */
  inputTokens?: number;
  /** Output tokens, when the provider reports token-based usage. */
  outputTokens?: number;
  /** Total tokens, when the provider reports token-based usage. */
  totalTokens?: number;
}

/**
 * Declared capabilities of a connector so callers can branch without
 * hardcoding provider quirks (e.g. whether to transcode before upload).
 */
export interface SttCapabilities {
  /** Whether the provider can translate to English (the translate path). */
  translation: boolean;
  /** Whether the provider auto-detects the spoken language. */
  autoDetectLanguage: boolean;
  /** Hard upload limit in bytes enforced by the provider. */
  maxBytes: number;
  /**
   * Container/codec formats the provider accepts natively (lowercase, no dot,
   * e.g. `wav`, `mp3`). Telegram voice notes are `ogg`/Opus; a provider whose
   * list omits `ogg` requires a transcode in its implementation.
   */
  formats: string[];
}
