import { ConfigService } from '@nestjs/config';

import { SttConfigProvider } from './stt.config';
import { SttProvider } from './stt.types';

/**
 * Builds a ConfigService stub whose `get` returns values from a fixed record.
 */
const buildConfigService = (env: Record<string, string | undefined>) =>
  ({
    get: (key: string) => env[key],
  }) as unknown as ConfigService;

describe('SttConfigProvider', () => {
  it('parses a fully-specified config', () => {
    const provider = new SttConfigProvider(
      buildConfigService({
        STT_PROVIDER: 'openai',
        OPENAI_API_KEY: 'sk-test',
        STT_MODEL: 'gpt-4o-transcribe',
        STT_TRANSLATE_TO_ENGLISH: 'true',
      }),
    );

    expect(provider.values).toEqual({
      provider: SttProvider.OPENAI,
      openAiApiKey: 'sk-test',
      model: 'gpt-4o-transcribe',
      translateToEnglish: true,
    });
  });

  it('applies defaults for provider, model, and translateToEnglish', () => {
    const provider = new SttConfigProvider(
      buildConfigService({ OPENAI_API_KEY: 'sk-test' }),
    );

    expect(provider.values.provider).toBe(SttProvider.OPENAI);
    expect(provider.values.model).toBe('gpt-4o-mini-transcribe');
    expect(provider.values.translateToEnglish).toBe(false);
  });

  it('treats any non-"true" STT_TRANSLATE_TO_ENGLISH as false', () => {
    const provider = new SttConfigProvider(
      buildConfigService({
        OPENAI_API_KEY: 'sk-test',
        STT_TRANSLATE_TO_ENGLISH: 'yes',
      }),
    );

    expect(provider.values.translateToEnglish).toBe(false);
  });

  it('fails fast when OPENAI_API_KEY is missing', () => {
    expect(
      () =>
        new SttConfigProvider(buildConfigService({ STT_PROVIDER: 'openai' })),
    ).toThrow(/Invalid STT configuration/);
  });

  it('fails fast on an unknown provider', () => {
    expect(
      () =>
        new SttConfigProvider(
          buildConfigService({
            STT_PROVIDER: 'deepgram',
            OPENAI_API_KEY: 'sk-test',
          }),
        ),
    ).toThrow(/Invalid STT configuration/);
  });
});
