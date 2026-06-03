import {
  SttCapabilities,
  SttProvider,
  TranscribeOptions,
  TranscriptionResult,
} from './stt.types';
import { MediaPayload } from '@/modules/external-vendor/external-vendor.types';

/**
 * Provider-agnostic speech-to-text contract (ADR 0007). Each implementation
 * declares its `provider` and `capabilities` and turns an audio payload into a
 * normalized `TranscriptionResult`. The abstraction is thin: one unit of work
 * per call (one transcription). Orchestration (persisting the transcript,
 * pipeline wiring) lives in the consuming feature, not here.
 */
export abstract class SttConnector {
  /** The provider this connector implements. */
  abstract readonly provider: SttProvider;

  /** Declared capabilities so callers can branch without provider knowledge. */
  abstract readonly capabilities: SttCapabilities;

  /**
   * Transcribe an audio payload to text. Returns the transcript in the source
   * language by default; set `options.translateToEnglish` to translate instead
   * (only valid when `capabilities.translation` is true).
   */
  abstract transcribe(
    audio: MediaPayload,
    options?: TranscribeOptions,
  ): Promise<TranscriptionResult>;
}
