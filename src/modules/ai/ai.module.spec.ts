import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';

import { AiConnectorFactory } from './ai-connector.factory';
import { ACTIVE_AI_CONNECTOR, AiModule } from './ai.module';
import { AiProvider } from './ai.types';
import { AnthropicAiConnector } from './anthropic/anthropic-ai.connector';

// Avoid constructing a real SDK client (no network, no key needed).
jest.mock('@anthropic-ai/sdk', () =>
  jest.fn().mockImplementation(() => ({
    messages: { create: jest.fn() },
    beta: { messages: { create: jest.fn() } },
  })),
);

/**
 * Builds a `ConfigService` double from a plain env record for module wiring.
 */
const buildConfigService = (
  values: Record<string, string | undefined>,
): ConfigService =>
  ({
    get: <T>(key: string): T => values[key] as unknown as T,
  }) as unknown as ConfigService;

/**
 * A `@Global()` module that provides and exports a mock `ConfigService`,
 * mirroring how the app registers `ConfigModule` globally
 * (`getConfigModule` → `isGlobal: true`). This makes `ConfigService` visible to
 * `AiModule`'s `AiConfig` across the module boundary, so the test exercises the
 * real `AiModule` DI graph rather than a flattened one.
 */
const buildConfigModule = (values: Record<string, string | undefined>) => {
  @Global()
  @Module({
    providers: [
      { provide: ConfigService, useValue: buildConfigService(values) },
    ],
    exports: [ConfigService],
  })
  class TestConfigModule {}

  return TestConfigModule;
};

const VALID_ENV: Record<string, string | undefined> = {
  ASSISTANT_AI_PROVIDER: 'anthropic',
  ANTHROPIC_API_KEY: 'sk-test',
  ASSISTANT_MODEL_MAIN: 'claude-sonnet',
  ASSISTANT_MODEL_BACKGROUND: 'claude-haiku',
};

describe('AiModule', () => {
  it('resolves ACTIVE_AI_CONNECTOR to the Anthropic implementation', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [buildConfigModule(VALID_ENV), AiModule],
    }).compile();

    const active = moduleRef.get(ACTIVE_AI_CONNECTOR);
    const factory = moduleRef.get(AiConnectorFactory);

    expect(active).toBeInstanceOf(AnthropicAiConnector);
    expect(active.provider).toBe(AiProvider.ANTHROPIC);
    expect(factory.getActive()).toBe(active);

    await moduleRef.close();
  });

  it('fails fast at startup on an unknown ASSISTANT_AI_PROVIDER', async () => {
    await expect(
      Test.createTestingModule({
        imports: [
          buildConfigModule({ ...VALID_ENV, ASSISTANT_AI_PROVIDER: 'mystery' }),
          AiModule,
        ],
      }).compile(),
    ).rejects.toThrow(/ASSISTANT_AI_PROVIDER/);
  });
});
