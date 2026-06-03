import { Module } from '@nestjs/common';

import { AiConnector } from './ai-connector.abstract';
import { AiConnectorFactory } from './ai-connector.factory';
import { AiConfig } from './ai.config';
import { AnthropicAiConnector } from './anthropic/anthropic-ai.connector';

/**
 * Injection token resolving to the active {@link AiConnector} (the one selected
 * by `ASSISTANT_AI_PROVIDER`). Consumers inject this to depend only on the
 * abstract contract; resolution happens once at startup, failing fast on an
 * unknown/unconfigured provider (ADR 0007).
 */
export const ACTIVE_AI_CONNECTOR = 'ACTIVE_AI_CONNECTOR';

/**
 * AI connector module (ADR 0007). Registers the typed config, the concrete
 * connector(s), and the factory; exports the factory and the
 * `ACTIVE_AI_CONNECTOR` token for the assistant orchestrator (Task 3) to wire.
 */
@Module({
  providers: [
    AiConfig,
    AnthropicAiConnector,
    AiConnectorFactory,
    {
      provide: ACTIVE_AI_CONNECTOR,
      inject: [AiConnectorFactory],
      useFactory: (factory: AiConnectorFactory): AiConnector =>
        factory.getActive(),
    },
  ],
  exports: [AiConnectorFactory, ACTIVE_AI_CONNECTOR],
})
export class AiModule {}
