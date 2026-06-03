import 'reflect-metadata';

import { Logger } from '@nestjs/common';
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
  const logger = new Logger('Bootstrap', { timestamp: true });
  const port = configService.get('PORT', { infer: true }) || 3000;

  app.enableCors({ origin: true, credentials: false });

  await app.listen(port);

  logger.log(''.padEnd(50, '='));
  logger.log(''.padEnd(50, ' '));
  logger.log(
    `Cue API is running in ${configService.get('NODE_ENV')} mode on`.padEnd(
      50,
      ' ',
    ),
  );
  logger.log(''.padEnd(50, ' '));
  logger.log(`http://127.0.0.1:${port}`.padEnd(50, ' '));

  if (configService.get('NODE_ENV') === 'development') {
    logger.log(''.padEnd(50, ' '));
    logger.log('Happy Development ✨'.padEnd(49, ' '));
  } else {
    logger.log(''.padEnd(50, ' '));
    logger.log('Good Luck in Production 💀'.padEnd(50, ' '));
  }

  logger.log(''.padEnd(50, ' '));
  logger.log(''.padEnd(50, '='));
};

void bootstrap();
