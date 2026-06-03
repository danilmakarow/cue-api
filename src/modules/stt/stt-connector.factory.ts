import { Injectable } from '@nestjs/common';

import { OpenAiSttConnector } from './openai/openai-stt.connector';
import { SttConnector } from './stt-connector.abstract';
import { SttConfigProvider } from './stt.config';
import { SttProvider } from './stt.types';

/**
 * Resolves the active speech-to-text connector from configuration (ADR 0007).
 * Holds a registry of every implementation keyed by `SttProvider`, exposes
 * `getActive()` for the configured provider and `get(provider)` for explicit
 * selection, and fails fast on an unknown/unregistered provider so
 * misconfiguration surfaces at startup rather than at the first voice note.
 */
@Injectable()
export class SttConnectorFactory {
  private readonly connectors: ReadonlyMap<SttProvider, SttConnector>;

  constructor(
    private readonly configProvider: SttConfigProvider,
    openAiConnector: OpenAiSttConnector,
  ) {
    this.connectors = new Map<SttProvider, SttConnector>([
      [SttProvider.OPENAI, openAiConnector],
    ]);
  }

  /**
   * Returns the connector for the provider selected by `STT_PROVIDER`.
   * Throws if that provider has no registered implementation.
   */
  getActive(): SttConnector {
    return this.get(this.configProvider.values.provider);
  }

  /**
   * Returns the connector for an explicit provider — keeps future providers
   * (Groq / Deepgram) selectable once registered. Throws on an unknown one.
   */
  get(provider: SttProvider): SttConnector {
    const connector = this.connectors.get(provider);

    if (!connector) {
      const available = [...this.connectors.keys()].join(', ');

      throw new Error(
        `No STT connector registered for provider "${provider}". Available: ${available}`,
      );
    }

    return connector;
  }
}
