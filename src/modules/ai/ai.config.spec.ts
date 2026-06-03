import { ConfigService } from '@nestjs/config';

import { AiConfig } from './ai.config';
import { AiModelRole, AiProvider } from './ai.types';

/**
 * Builds a `ConfigService` test double backed by a plain record, so `AiConfig`
 * validation runs against controlled env values.
 */
const buildConfigService = (
  values: Record<string, string | number | undefined>,
): ConfigService =>
  ({
    get: <T>(key: string): T => values[key] as unknown as T,
  }) as unknown as ConfigService;

const VALID_ENV: Record<string, string | number | undefined> = {
  ANTHROPIC_API_KEY: 'sk-test',
  ASSISTANT_MODEL_MAIN: 'claude-sonnet',
  ASSISTANT_MODEL_BACKGROUND: 'claude-haiku',
};

describe('AiConfig', () => {
  it('defaults the provider to Anthropic when ASSISTANT_AI_PROVIDER is unset', () => {
    const config = new AiConfig(buildConfigService({ ...VALID_ENV }));

    expect(config.getProvider()).toBe(AiProvider.ANTHROPIC);
  });

  it('maps model roles to their configured ids', () => {
    const config = new AiConfig(buildConfigService({ ...VALID_ENV }));

    expect(config.getModelId(AiModelRole.MAIN)).toBe('claude-sonnet');
    expect(config.getModelId(AiModelRole.BACKGROUND)).toBe('claude-haiku');
  });

  it('uses the default output-token ceiling when unset', () => {
    const config = new AiConfig(buildConfigService({ ...VALID_ENV }));

    expect(config.getMaxOutputTokens()).toBeGreaterThan(0);
  });

  it('reads a valid ASSISTANT_MAX_OUTPUT_TOKENS override', () => {
    const config = new AiConfig(
      buildConfigService({ ...VALID_ENV, ASSISTANT_MAX_OUTPUT_TOKENS: '2048' }),
    );

    expect(config.getMaxOutputTokens()).toBe(2048);
  });

  it('defaults max retries to 2 when ASSISTANT_AI_MAX_RETRIES is unset', () => {
    const config = new AiConfig(buildConfigService({ ...VALID_ENV }));

    expect(config.getMaxRetries()).toBe(2);
  });

  it('reads a valid ASSISTANT_AI_MAX_RETRIES override', () => {
    const config = new AiConfig(
      buildConfigService({ ...VALID_ENV, ASSISTANT_AI_MAX_RETRIES: '5' }),
    );

    expect(config.getMaxRetries()).toBe(5);
  });

  it('allows ASSISTANT_AI_MAX_RETRIES of 0 to disable retries', () => {
    const config = new AiConfig(
      buildConfigService({ ...VALID_ENV, ASSISTANT_AI_MAX_RETRIES: '0' }),
    );

    expect(config.getMaxRetries()).toBe(0);
  });

  it('fails fast on a negative ASSISTANT_AI_MAX_RETRIES', () => {
    expect(
      () =>
        new AiConfig(
          buildConfigService({
            ...VALID_ENV,
            ASSISTANT_AI_MAX_RETRIES: '-1',
          }),
        ),
    ).toThrow(/ASSISTANT_AI_MAX_RETRIES/);
  });

  it('fails fast when ANTHROPIC_API_KEY is missing', () => {
    expect(
      () =>
        new AiConfig(
          buildConfigService({ ...VALID_ENV, ANTHROPIC_API_KEY: undefined }),
        ),
    ).toThrow(/ANTHROPIC_API_KEY/);
  });

  it('fails fast on an unknown ASSISTANT_AI_PROVIDER', () => {
    expect(
      () =>
        new AiConfig(
          buildConfigService({ ...VALID_ENV, ASSISTANT_AI_PROVIDER: 'openai' }),
        ),
    ).toThrow(/ASSISTANT_AI_PROVIDER/);
  });

  it('fails fast on a non-positive ASSISTANT_MAX_OUTPUT_TOKENS', () => {
    expect(
      () =>
        new AiConfig(
          buildConfigService({
            ...VALID_ENV,
            ASSISTANT_MAX_OUTPUT_TOKENS: '0',
          }),
        ),
    ).toThrow(/ASSISTANT_MAX_OUTPUT_TOKENS/);
  });
});
