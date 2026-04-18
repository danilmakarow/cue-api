import 'reflect-metadata';

import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';
import { EnvironmentVariables } from '@/config/env.config';

/**
 * Bootstraps the NestJS application — binds middleware, enables CORS, and starts the HTTP listener.
 */
const bootstrap = async () => {
  const app = await NestFactory.create(AppModule);
  const configService = app.get(ConfigService<EnvironmentVariables>);
  const port = configService.get('PORT', { infer: true }) || 3000;

  app.enableCors({ origin: '*' });

  await app.listen(port);

  console.log(
    `Cue API running in ${configService.get('NODE_ENV')} mode on http://127.0.0.1:${port}`,
  );
};

void bootstrap();
