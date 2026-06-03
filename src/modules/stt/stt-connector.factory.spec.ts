import { OpenAiSttConnector } from './openai/openai-stt.connector';
import { SttConnectorFactory } from './stt-connector.factory';
import { SttConfigProvider } from './stt.config';
import { SttProvider } from './stt.types';

/**
 * Builds a factory with a stubbed config provider reporting the given provider
 * and a stand-in OpenAI connector instance.
 */
const buildFactory = (provider: SttProvider) => {
  const openAiConnector = {
    provider: SttProvider.OPENAI,
  } as OpenAiSttConnector;
  const configProvider = {
    values: { provider },
  } as unknown as SttConfigProvider;
  const factory = new SttConnectorFactory(configProvider, openAiConnector);

  return { factory, openAiConnector };
};

describe('SttConnectorFactory', () => {
  it('getActive() returns the connector for the configured provider', () => {
    const { factory, openAiConnector } = buildFactory(SttProvider.OPENAI);

    expect(factory.getActive()).toBe(openAiConnector);
  });

  it('get() returns the OpenAI connector by explicit provider', () => {
    const { factory, openAiConnector } = buildFactory(SttProvider.OPENAI);

    expect(factory.get(SttProvider.OPENAI)).toBe(openAiConnector);
  });

  it('fails fast on an unknown / unregistered provider', () => {
    const { factory } = buildFactory(SttProvider.OPENAI);

    expect(() => factory.get('groq' as SttProvider)).toThrow(
      /No STT connector registered/,
    );
  });

  it('getActive() fails fast when the configured provider is unregistered', () => {
    const { factory } = buildFactory('deepgram' as SttProvider);

    expect(() => factory.getActive()).toThrow(/No STT connector registered/);
  });
});
