import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';

import { OpenAiSttConnector } from './openai/openai-stt.connector';
import { SttConnector } from './stt-connector.abstract';
import { SttConnectorFactory } from './stt-connector.factory';
import { ACTIVE_STT_CONNECTOR, SttModule } from './stt.module';
import { SttProvider } from './stt.types';

// The OpenAI SDK is constructed in the connector's constructor; stub it so the
// module boots without a real network client.
jest.mock('openai', () => {
  class OpenAI {
    audio = {
      transcriptions: { create: jest.fn() },
      translations: { create: jest.fn() },
    };
  }

  return {
    __esModule: true,
    default: OpenAI,
    APIError: class extends Error {},
    toFile: jest.fn(),
  };
});

// Avoid touching the real ffmpeg binary during module bootstrap.
jest.mock('ffmpeg-static', () => ({
  __esModule: true,
  default: '/fake/ffmpeg',
}));
jest.mock('fluent-ffmpeg', () => {
  const factory = jest.fn();

  (factory as unknown as { setFfmpegPath: jest.Mock }).setFfmpegPath =
    jest.fn();

  return { __esModule: true, default: factory };
});

/**
 * Builds a ConfigService stub for the given env record.
 */
const configServiceStub = (env: Record<string, string | undefined>) =>
  ({ get: (key: string) => env[key] }) as unknown as ConfigService;

describe('SttModule (integration)', () => {
  it('resolves ACTIVE_STT_CONNECTOR to the OpenAI connector', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [SttModule] })
      .overrideProvider(ConfigService)
      .useValue(
        configServiceStub({
          STT_PROVIDER: 'openai',
          OPENAI_API_KEY: 'sk-test',
        }),
      )
      .compile();

    const active = moduleRef.get<SttConnector>(ACTIVE_STT_CONNECTOR);
    const factory = moduleRef.get(SttConnectorFactory);

    expect(active).toBeInstanceOf(OpenAiSttConnector);
    expect(active.provider).toBe(SttProvider.OPENAI);
    expect(factory.getActive()).toBe(active);

    await moduleRef.close();
  });

  it('fails fast at startup on an unknown STT_PROVIDER', async () => {
    await expect(
      Test.createTestingModule({ imports: [SttModule] })
        .overrideProvider(ConfigService)
        .useValue(
          configServiceStub({
            STT_PROVIDER: 'deepgram',
            OPENAI_API_KEY: 'sk-test',
          }),
        )
        .compile(),
    ).rejects.toThrow(/Invalid STT configuration/);
  });
});
