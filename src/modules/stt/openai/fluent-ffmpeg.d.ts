/**
 * Minimal local type declaration for `fluent-ffmpeg`.
 *
 * The package ships no types and `@types/fluent-ffmpeg` is intentionally not a
 * dependency (the project leans "vendor/own over new deps"). We declare only
 * the slice of the chainable API the transcoder uses, so the connector stays
 * `any`-free under `strict`/`noImplicitAny`. Extend this if the transcode grows.
 */
declare module 'fluent-ffmpeg' {
  import { Readable, Writable } from 'stream';

  /** A chainable ffmpeg command instance. */
  interface FfmpegCommand {
    /** Override the input container/codec ffmpeg should expect. */
    inputFormat(format: string): this;
    /** Set the output audio sample rate in Hz (e.g. 16000). */
    audioFrequency(frequency: number): this;
    /** Set the number of output audio channels (1 = mono). */
    audioChannels(channels: number): this;
    /** Set the output audio codec (e.g. `pcm_s16le` for WAV). */
    audioCodec(codec: string): this;
    /** Set the output container format (e.g. `wav`). */
    toFormat(format: string): this;
    /** Register an error handler. */
    on(event: 'error', handler: (error: Error) => void): this;
    /** Register an end-of-processing handler. */
    on(event: 'end', handler: () => void): this;
    /** Register an arbitrary event handler. */
    on(event: string, handler: (...args: unknown[]) => void): this;
    /** Pipe the output to a writable stream. */
    pipe(destination: Writable, options?: { end?: boolean }): Writable;
  }

  /** The ffmpeg command factory. */
  interface FfmpegConstructor {
    (input?: string | Readable): FfmpegCommand;
    /** Point fluent-ffmpeg at a specific ffmpeg binary. */
    setFfmpegPath(path: string): void;
  }

  const ffmpeg: FfmpegConstructor;

  export = ffmpeg;
}
