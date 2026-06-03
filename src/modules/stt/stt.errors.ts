import { SttProvider } from './stt.types';

/**
 * Base class for all speech-to-text connector errors. Lets the consumer catch
 * the whole family (`catch (e) { if (e instanceof SttError) ... }`) and map it
 * to a user-facing reply without depending on a specific provider's SDK errors.
 */
export abstract class SttError extends Error {
  protected constructor(
    message: string,
    readonly provider: SttProvider,
    options?: { cause?: unknown },
  ) {
    super(message, options as ErrorOptions);
    this.name = new.target.name;
  }
}

/**
 * Thrown before any upload when the audio exceeds the provider's hard size
 * limit. Surfacing this as a typed error (rather than a raw SDK 413) lets the
 * consumer give a clear "that recording is too large" reply and avoids a wasted
 * transcode/upload round-trip.
 */
export class SttPayloadTooLargeError extends SttError {
  constructor(
    provider: SttProvider,
    readonly sizeBytes: number,
    readonly maxBytes: number,
  ) {
    super(
      `Audio payload of ${sizeBytes} bytes exceeds the ${provider} limit of ${maxBytes} bytes`,
      provider,
    );
  }
}

/**
 * Thrown when a requested option isn't supported by the active provider — e.g.
 * `translateToEnglish` against a connector whose `capabilities.translation` is
 * false. Fail loud rather than silently returning a source-language transcript.
 */
export class SttCapabilityNotSupportedError extends SttError {
  constructor(provider: SttProvider, capability: string) {
    super(`Provider ${provider} does not support ${capability}`, provider);
  }
}

/**
 * Thrown when the provider is unavailable after bounded retries (429 / 5xx /
 * network). The consumer maps this to the spec's "couldn't hear that, try
 * again" reply. The originating SDK error is preserved on `cause`.
 */
export class SttUnavailableError extends SttError {
  constructor(provider: SttProvider, cause?: unknown) {
    super(
      `Speech-to-text provider ${provider} is currently unavailable`,
      provider,
      { cause },
    );
  }
}
