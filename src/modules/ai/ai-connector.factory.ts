import { Injectable } from '@nestjs/common';

import { AiConnector } from './ai-connector.abstract';
import { AiConfig } from './ai.config';
import { AiProvider } from './ai.types';
import { AnthropicAiConnector } from './anthropic/anthropic-ai.connector';

/**
 * Resolves the active {@link AiConnector} from config (ADR 0007). Holds a
 * registry of all implementations keyed by provider; `getActive()` returns the
 * one selected by `ASSISTANT_AI_PROVIDER`, while `get(provider)` keeps a future
 * multi-provider world available. An unknown/unconfigured provider fails fast.
 */
@Injectable()
export class AiConnectorFactory {
  private readonly connectors: Map<AiProvider, AiConnector>;

  constructor(
    private readonly config: AiConfig,
    anthropicConnector: AnthropicAiConnector,
  ) {
    this.connectors = new Map<AiProvider, AiConnector>([
      [AiProvider.ANTHROPIC, anthropicConnector],
    ]);
  }

  /**
   * Returns the connector for a specific provider, throwing when no
   * implementation is registered for it.
   */
  get(provider: AiProvider): AiConnector {
    const connector = this.connectors.get(provider);

    if (!connector) {
      throw new Error(`No AI connector registered for provider "${provider}"`);
    }

    return connector;
  }

  /**
   * Returns the connector for the configured active provider. Throws when that
   * provider has no registered implementation — surfaced at startup via the
   * `ACTIVE_AI_CONNECTOR` factory provider, not at the first model call.
   */
  getActive(): AiConnector {
    return this.get(this.config.getProvider());
  }
}
