import { PassThrough } from 'stream';

const mockSetFfmpegPath = jest.fn();

/** A controllable fake ffmpeg command capturing the configured chain. */
interface FakeCommand {
  inputFormat: jest.Mock;
  audioFrequency: jest.Mock;
  audioChannels: jest.Mock;
  audioCodec: jest.Mock;
  toFormat: jest.Mock;
  on: jest.Mock;
  pipe: jest.Mock;
}

// The most-recent fake command is captured here for assertions. Wrapped in an
// object so the `jest.mock` factory (hoisted above) may reference it — only
// `mock`-prefixed identifiers survive the hoist.
const mockState: { lastCommand?: FakeCommand } = {};

// Mock fluent-ffmpeg with a chainable command whose `pipe` emits bytes into the
// provided PassThrough so the transcoder's stream-collection resolves.
jest.mock('fluent-ffmpeg', () => {
  const factory = jest.fn(() => {
    const handlers: Record<string, (...args: unknown[]) => void> = {};
    const command: FakeCommand = {
      inputFormat: jest.fn().mockReturnThis(),
      audioFrequency: jest.fn().mockReturnThis(),
      audioChannels: jest.fn().mockReturnThis(),
      audioCodec: jest.fn().mockReturnThis(),
      toFormat: jest.fn().mockReturnThis(),
      on: jest.fn((event: string, handler: (...args: unknown[]) => void) => {
        handlers[event] = handler;

        return command;
      }),
      pipe: jest.fn((destination: PassThrough) => {
        setImmediate(() => {
          destination.write(Buffer.from('wav-out'));
          destination.end();
        });

        return destination;
      }),
    };

    mockState.lastCommand = command;

    return command;
  }) as jest.Mock & { setFfmpegPath: jest.Mock };

  factory.setFfmpegPath = mockSetFfmpegPath;

  return { __esModule: true, default: factory };
});

jest.mock('ffmpeg-static', () => ({
  __esModule: true,
  default: '/fake/path/to/ffmpeg',
}));

import ffmpeg from 'fluent-ffmpeg';

import { AudioTranscoder } from './audio-transcoder';

describe('AudioTranscoder', () => {
  let transcoder: AudioTranscoder;

  beforeEach(() => {
    transcoder = new AudioTranscoder();
  });

  it('points fluent-ffmpeg at the ffmpeg-static binary on import', () => {
    mockSetFfmpegPath.mockClear();

    // Re-require under an isolated registry so the module-load side effect is
    // observed deterministically, regardless of earlier imports caching it.
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('./audio-transcoder');
    });

    expect(mockSetFfmpegPath).toHaveBeenCalledWith('/fake/path/to/ffmpeg');
  });

  it('transcodes OGG bytes to 16 kHz mono WAV and returns the output buffer', async () => {
    const result = await transcoder.oggToWav(Buffer.from('ogg-in'));

    expect(ffmpeg).toHaveBeenCalledTimes(1);

    const command = mockState.lastCommand;

    expect(command?.inputFormat).toHaveBeenCalledWith('ogg');
    expect(command?.audioFrequency).toHaveBeenCalledWith(16000);
    expect(command?.audioChannels).toHaveBeenCalledWith(1);
    expect(command?.audioCodec).toHaveBeenCalledWith('pcm_s16le');
    expect(command?.toFormat).toHaveBeenCalledWith('wav');
    expect(result).toEqual(Buffer.from('wav-out'));
  });

  it('rejects when ffmpeg emits an error', async () => {
    const factory = ffmpeg as unknown as jest.Mock;

    // One-off command whose pipe triggers the registered error handler.
    factory.mockImplementationOnce(() => {
      const handlers: Record<string, (...args: unknown[]) => void> = {};
      const command: FakeCommand = {
        inputFormat: jest.fn().mockReturnThis(),
        audioFrequency: jest.fn().mockReturnThis(),
        audioChannels: jest.fn().mockReturnThis(),
        audioCodec: jest.fn().mockReturnThis(),
        toFormat: jest.fn().mockReturnThis(),
        on: jest.fn((event: string, handler: (...args: unknown[]) => void) => {
          handlers[event] = handler;

          return command;
        }),
        pipe: jest.fn(() => {
          setImmediate(() => handlers.error?.(new Error('ffmpeg boom')));

          return new PassThrough();
        }),
      };

      return command;
    });

    await expect(transcoder.oggToWav(Buffer.from('ogg-in'))).rejects.toThrow(
      'ffmpeg boom',
    );
  });
});
