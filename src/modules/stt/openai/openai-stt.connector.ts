import { Injectable, Logger } from '@nestjs/common';
import OpenAI, { APIError, toFile } from 'openai';

import { SttConnector } from '../stt-connector.abstract';
import { SttConfigProvider } from '../stt.config';
import {
  SttCapabilityNotSupportedError,
  SttPayloadTooLargeError,
  SttUnavailableError,
} from '../stt.errors';
import {
  SttCapabilities,
  SttProvider,
  SttUsage,
  TranscribeOptions,
  TranscriptionResult,
} from '../stt.types';
import { AudioTranscoder } from './audio-transcoder';
import { MediaPayload } from '@/modules/external-vendor/external-vendor.types';

/** OpenAI's hard request limit for the audio endpoints. */
const OPENAI_MAX_BYTES = 25 * 1024 * 1024;
/** Model used for the translate-to-English path (translations support only this). */
const TRANSLATION_MODEL = 'whisper-1';
/** Filename handed to the upload — the `.wav` extension signals the container. */
const UPLOAD_FILENAME = 'audio.wav';
const WAV_MIME_TYPE = 'audio/wav';
/** Substrings that mark a Telegram voice note as OGG/Opus (needs transcode). */
const OGG_MIME_HINTS = ['ogg', 'opus'];

/** Retry policy for transient provider failures (429 / 5xx / network). */
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 250;

/**
 * Minimal shape of an OpenAI verbose audio response. The `whisper-1` translate
 * path returns these extra fields; the typed SDK result for `verbose_json` is
 * mapped through this so we surface language/duration without `any`.
 */
interface VerboseAudioResponse {
  text: string;
  language?: string;
  duration?: number;
}

/**
 * Identifies which audio call failed, for logging. `operation` is `transcribe`
 * or `translate`; `model` is the concrete model id used for that call.
 */
interface OpenAiCallContext {
  operation: string;
  model: string;
}

/**
 * Provider-side detail extracted from a failed OpenAI call, for logging only.
 * All metadata — never transcript, prompt, or audio content. `status`/`code`/
 * `errorType` are absent on transport (network) failures; `retryable` mirrors
 * {@link isRetryable}.
 */
interface OpenAiErrorDetail {
  status?: number;
  code?: string;
  errorType?: string;
  requestId?: string;
  retryable: boolean;
  message: string;
}

/**
 * Sleeps for the given number of milliseconds.
 */
const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Decides whether a failed request is worth retrying — transient transport
 * errors (network) and provider 429 / 5xx, but not 4xx client errors.
 */
const isRetryable = (error: unknown): boolean => {
  if (error instanceof APIError) {
    const status = error.status;

    return status === 429 || (typeof status === 'number' && status >= 500);
  }

  // No HTTP status → connection/network error; worth a retry.
  return error instanceof Error;
};

/**
 * Speech-to-text connector backed by the official `openai` SDK. Transcribes via
 * `gpt-4o-mini-transcribe` by default and translates to English via `whisper-1`
 * when asked. Telegram voice notes are OGG/Opus, which these models reject, so
 * OGG input is transcoded to 16 kHz mono WAV before upload.
 *
 * API shape (model names, params, response fields, the OGG-format gotcha, and
 * the 25 MB limit) was taken from the installed `openai@6.39.1` type
 * definitions plus prior knowledge of the OpenAI audio API.
 */
@Injectable()
export class OpenAiSttConnector extends SttConnector {
  readonly provider = SttProvider.OPENAI;

  readonly capabilities: SttCapabilities = {
    translation: true,
    autoDetectLanguage: true,
    maxBytes: OPENAI_MAX_BYTES,
    // OpenAI accepts these natively; note OGG/Opus is absent — hence the transcode.
    formats: ['flac', 'mp3', 'mp4', 'mpeg', 'mpga', 'm4a', 'wav', 'webm'],
  };

  private readonly logger = new Logger(OpenAiSttConnector.name);

  private readonly client: OpenAI;

  constructor(
    private readonly configProvider: SttConfigProvider,
    private readonly transcoder: AudioTranscoder,
  ) {
    super();
    this.client = new OpenAI({
      apiKey: this.configProvider.values.openAiApiKey,
      // Disable the SDK's built-in retries (default 2): this connector owns
      // retry policy via `withRetry`. Leaving both on would stack — the SDK
      // would retry under each of our attempts, ballooning one transient
      // failure into ~9 calls and stalling the consumer.
      maxRetries: 0,
    });
  }

  /**
   * Maps an OpenAI verbose audio response onto the normalized result shape.
   */
  private static toResult(
    response: VerboseAudioResponse,
    usage?: SttUsage,
  ): TranscriptionResult {
    return {
      text: response.text,
      language: response.language,
      durationSeconds: response.duration,
      usage,
    };
  }

  /**
   * Pulls best-effort usage stats off an OpenAI audio response. Shapes differ
   * by model (token-based for gpt-4o-*, duration-based for whisper), so each
   * field is read defensively and omitted when absent.
   */
  private static extractUsage(response: unknown): SttUsage | undefined {
    if (typeof response !== 'object' || response === null) return undefined;

    const usage = (response as { usage?: Record<string, unknown> }).usage;

    if (!usage) return undefined;

    const result: SttUsage = {};

    if (typeof usage.seconds === 'number') result.seconds = usage.seconds;
    if (typeof usage.input_tokens === 'number') {
      result.inputTokens = usage.input_tokens;
    }
    if (typeof usage.output_tokens === 'number') {
      result.outputTokens = usage.output_tokens;
    }
    if (typeof usage.total_tokens === 'number') {
      result.totalTokens = usage.total_tokens;
    }

    return Object.keys(result).length > 0 ? result : undefined;
  }

  /**
   * True when the payload's MIME type indicates OGG/Opus (Telegram voice notes)
   * and therefore needs transcoding before upload.
   */
  private isOggOpus(mimeType: string): boolean {
    const normalized = mimeType.toLowerCase();

    return OGG_MIME_HINTS.some((hint) => normalized.includes(hint));
  }

  /**
   * Guards the OpenAI 25 MB limit before any transcode/upload work, throwing a
   * typed error rather than letting the SDK fail with a raw 413.
   */
  private assertWithinSizeLimit(sizeBytes: number): void {
    if (sizeBytes <= this.capabilities.maxBytes) return;

    this.logger.warn(
      `Audio payload rejected: provider=${this.provider} ` +
        `sizeBytes=${sizeBytes} maxBytes=${this.capabilities.maxBytes}`,
    );

    throw new SttPayloadTooLargeError(
      this.provider,
      sizeBytes,
      this.capabilities.maxBytes,
    );
  }

  /**
   * Ensures the audio is in an OpenAI-accepted container: transcodes OGG/Opus
   * to 16 kHz mono WAV, and passes anything already-supported through as-is.
   */
  private async ensureSupportedAudio(audio: MediaPayload): Promise<Buffer> {
    if (!this.isOggOpus(audio.mimeType)) return audio.bytes;

    this.logger.debug('Transcoding OGG/Opus audio to 16 kHz mono WAV');

    return this.transcoder.oggToWav(audio.bytes);
  }

  /**
   * Extracts log-safe provider detail from a failed call. For an OpenAI
   * `APIError` it reads the HTTP `status`, the provider `code` and `type`, and
   * the `request-id` (all exposed directly on the SDK error); `retryable` reuses
   * {@link isRetryable} so the log and the retry decision never diverge.
   * Non-API errors fall back to the message. Never touches audio or transcript.
   */
  private describeOpenAiError(error: unknown): OpenAiErrorDetail {
    if (!(error instanceof APIError)) {
      return {
        retryable: isRetryable(error),
        message: error instanceof Error ? error.message : String(error),
      };
    }

    return {
      status: typeof error.status === 'number' ? error.status : undefined,
      code: error.code ?? undefined,
      errorType: error.type ?? undefined,
      requestId: error.requestID ?? undefined,
      retryable: isRetryable(error),
      message: error.message,
    };
  }

  /**
   * Runs an OpenAI audio call with bounded exponential backoff on transient
   * failures, throwing `SttUnavailableError` once retries are exhausted. `context`
   * names the failing operation/model for the logs. Each retryable attempt logs a
   * one-line `warn`; the terminal failure logs one `error` with the full provider
   * detail. Logs are metadata only — never audio bytes or transcript text.
   */
  private async withRetry<ResultType>(
    context: OpenAiCallContext,
    operation: () => Promise<ResultType>,
  ): Promise<ResultType> {
    let lastError: unknown;
    let attemptsTried = 0;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      attemptsTried = attempt;

      try {
        return await operation();
      } catch (error) {
        lastError = error;

        const detail = this.describeOpenAiError(error);

        if (!detail.retryable || attempt === MAX_ATTEMPTS) break;

        const backoff = BASE_BACKOFF_MS * 2 ** (attempt - 1);

        this.logger.warn(
          `OpenAI audio call failed: operation=${context.operation} ` +
            `model=${context.model} attempt=${attempt}/${MAX_ATTEMPTS} ` +
            `status=${detail.status ?? 'none'} code=${detail.code ?? 'none'} ` +
            `retryInMs=${backoff} message=${detail.message}`,
        );
        await delay(backoff);
      }
    }

    const detail = this.describeOpenAiError(lastError);

    this.logger.error(
      `OpenAI audio call gave up: operation=${context.operation} ` +
        `model=${context.model} attempts=${attemptsTried} ` +
        `status=${detail.status ?? 'none'} code=${detail.code ?? 'none'} ` +
        `errorType=${detail.errorType ?? 'none'} ` +
        `requestId=${detail.requestId ?? 'none'} retryable=${detail.retryable} ` +
        `message=${detail.message}`,
      lastError instanceof Error ? lastError.stack : undefined,
    );

    throw new SttUnavailableError(this.provider, lastError);
  }

  /**
   * Transcribes (or translates) a Telegram voice payload to text. Transcodes
   * OGG/Opus to WAV first (OpenAI rejects OGG), enforces the 25 MB limit, and
   * returns a normalized result in the source language unless
   * `options.translateToEnglish` is set.
   */
  async transcribe(
    audio: MediaPayload,
    options: TranscribeOptions = {},
  ): Promise<TranscriptionResult> {
    if (options.translateToEnglish && !this.capabilities.translation) {
      throw new SttCapabilityNotSupportedError(this.provider, 'translation');
    }

    this.assertWithinSizeLimit(audio.bytes.length);

    const wavBytes = await this.ensureSupportedAudio(audio);
    const file = await toFile(wavBytes, UPLOAD_FILENAME, {
      type: WAV_MIME_TYPE,
    });

    if (options.translateToEnglish) {
      return this.translate(file, options);
    }

    return this.transcribeSource(file, options);
  }

  /**
   * Transcribes in the source language via the configured transcription model.
   * `gpt-4o-*-transcribe` models support only `response_format: 'json'`, so the
   * response carries `text` (and optional usage) but not language/duration.
   */
  private async transcribeSource(
    file: Awaited<ReturnType<typeof toFile>>,
    options: TranscribeOptions,
  ): Promise<TranscriptionResult> {
    const model = this.configProvider.values.model;

    const response = await this.withRetry(
      { operation: 'transcribe', model },
      () =>
        this.client.audio.transcriptions.create({
          file,
          model,
          language: options.languageHint,
          prompt: options.prompt,
          response_format: 'json',
        }),
    );

    return OpenAiSttConnector.toResult(
      { text: response.text },
      OpenAiSttConnector.extractUsage(response),
    );
  }

  /**
   * Translates to English via `whisper-1` (the only model the translations
   * endpoint supports). Requests `verbose_json` so we get detected language and
   * duration alongside the translated text.
   */
  private async translate(
    file: Awaited<ReturnType<typeof toFile>>,
    options: TranscribeOptions,
  ): Promise<TranscriptionResult> {
    const response = await this.withRetry(
      { operation: 'translate', model: TRANSLATION_MODEL },
      () =>
        this.client.audio.translations.create({
          file,
          model: TRANSLATION_MODEL,
          prompt: options.prompt,
          response_format: 'verbose_json',
        }),
    );

    // `verbose_json` yields language + duration, but the SDK's create overload
    // widens our literal `response_format`, typing the result as the base
    // `Translation` ({ text }). Read through our own shape to surface those
    // extra fields without resorting to `any`.
    const verbose = response as unknown as VerboseAudioResponse;

    return OpenAiSttConnector.toResult(
      verbose,
      OpenAiSttConnector.extractUsage(response),
    );
  }
}
