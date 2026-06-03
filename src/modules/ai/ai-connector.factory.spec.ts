import { AiConnectorFactory } from './ai-connector.factory';
import { AiConfig } from './ai.config';
import { AiProvider } from './ai.types';
import { AnthropicAiConnector } from './anthropic/anthropic-ai.connector';

/**
 * Builds an `AiConfig` double whose active provider is configurable per test.
 */
const buildConfig = (provider: AiProvider | string): AiConfig =>
  ({
    getProvider: () => provider as AiProvider,
  }) as unknown as AiConfig;

const anthropicConnector = {
  provider: AiProvider.ANTHROPIC,
} as unknown as AnthropicAiConnector;

describe('AiConnectorFactory', () => {
  it('getActive returns the Anthropic connector for the anthropic provider', () => {
    const factory = new AiConnectorFactory(
      buildConfig(AiProvider.ANTHROPIC),
      anthropicConnector,
    );

    expect(factory.getActive()).toBe(anthropicConnector);
  });

  it('get(provider) returns the registered connector', () => {
    const factory = new AiConnectorFactory(
      buildConfig(AiProvider.ANTHROPIC),
      anthropicConnector,
    );

    expect(factory.get(AiProvider.ANTHROPIC)).toBe(anthropicConnector);
  });

  it('fails fast when the active provider has no registered connector', () => {
    const factory = new AiConnectorFactory(
      buildConfig('gemini'),
      anthropicConnector,
    );

    expect(() => factory.getActive()).toThrow(/No AI connector registered/);
  });
});
