import { PassThrough, Readable } from 'stream';

import { Injectable, Logger } from '@nestjs/common';
import ffmpegPath from 'ffmpeg-static';
import ffmpeg from 'fluent-ffmpeg';

/** Target sample rate for OpenAI-friendly WAV (16 kHz is plenty for speech). */
const TARGET_SAMPLE_RATE_HZ = 16000;
/** Mono — voice notes are single-channel and it halves the payload. */
const TARGET_CHANNELS = 1;
/** PCM signed 16-bit little-endian: standard uncompressed WAV. */
const WAV_CODEC = 'pcm_s16le';
const WAV_FORMAT = 'wav';
const OGG_INPUT_FORMAT = 'ogg';

if (ffmpegPath) {
  ffmpeg.setFfmpegPath(ffmpegPath);
}

/**
 * Collects all chunks emitted by a readable stream into a single Buffer.
 */
const collectStream = (stream: PassThrough): Promise<Buffer> => {
  const chunks: Buffer[] = [];

  return new Promise<Buffer>((resolve, reject) => {
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
};

/**
 * Transcodes audio bytes between formats via ffmpeg (the `ffmpeg-static`
 * binary). Isolated behind an injectable so the OpenAI connector depends on a
 * mockable seam and the untyped `fluent-ffmpeg` surface stays in one place.
 */
@Injectable()
export class AudioTranscoder {
  private readonly logger = new Logger(AudioTranscoder.name);

  /**
   * Transcodes OGG/Opus audio to 16 kHz mono PCM WAV — the format OpenAI's
   * transcription models accept (they reject OGG/Opus). Resolves the WAV bytes;
   * rejects if ffmpeg fails. Runs entirely in memory (no temp files).
   */
  oggToWav(oggBytes: Buffer): Promise<Buffer> {
    const input = Readable.from(oggBytes);
    const output = new PassThrough();
    const collected = collectStream(output);

    return new Promise<Buffer>((resolve, reject) => {
      ffmpeg(input)
        .inputFormat(OGG_INPUT_FORMAT)
        .audioFrequency(TARGET_SAMPLE_RATE_HZ)
        .audioChannels(TARGET_CHANNELS)
        .audioCodec(WAV_CODEC)
        .toFormat(WAV_FORMAT)
        .on('error', (error: Error) => {
          this.logger.error(`ffmpeg transcode failed: ${error.message}`);
          reject(error);
        })
        .pipe(output, { end: true });

      collected.then(resolve).catch(reject);
    });
  }
}
