import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AudioTranscoder } from './openai/audio-transcoder';
import { OpenAiSttConnector } from './openai/openai-stt.connector';
import { SttConnector } from './stt-connector.abstract';
import { SttConnectorFactory } from './stt-connector.factory';
import { SttConfigProvider } from './stt.config';

/**
 * Injection token for the active {@link SttConnector} (the one selected by
 * `STT_PROVIDER`). Inject this to transcribe without knowing the concrete
 * provider: `@Inject(ACTIVE_STT_CONNECTOR) private readonly stt: SttConnector`.
 */
export const ACTIVE_STT_CONNECTOR = Symbol('ACTIVE_STT_CONNECTOR');

/**
 * Speech-to-text connector module (ADR 0007). Registers the typed config, the
 * ffmpeg transcoder, every connector implementation, and the factory; exports
 * the factory plus the `ACTIVE_STT_CONNECTOR` binding resolved from config.
 */
@Module({
  imports: [ConfigModule],
  providers: [
    SttConfigProvider,
    AudioTranscoder,
    OpenAiSttConnector,
    SttConnectorFactory,
    {
      provide: ACTIVE_STT_CONNECTOR,
      useFactory: (factory: SttConnectorFactory): SttConnector =>
        factory.getActive(),
      inject: [SttConnectorFactory],
    },
  ],
  exports: [SttConnectorFactory, ACTIVE_STT_CONNECTOR],
})
export class SttModule {}
