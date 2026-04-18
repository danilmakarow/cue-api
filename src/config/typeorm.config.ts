import * as path from 'node:path';

import { ConfigService } from '@nestjs/config';
import { DataSource, DataSourceOptions } from 'typeorm';
import { PostgresConnectionOptions } from 'typeorm/driver/postgres/PostgresConnectionOptions';
import {
  addTransactionalDataSource,
  initializeTransactionalContext,
} from 'typeorm-transactional';

import { EnvironmentVariables } from './env.config';

/**
 * Builds the Postgres connection options for TypeORM from the environment configuration.
 */
export const getDatabaseConfig = (
  configService: ConfigService<EnvironmentVariables>,
): PostgresConnectionOptions => {
  const config: PostgresConnectionOptions = {
    type: 'postgres',
    host: configService.get('DB_HOST', { infer: true }),
    port: configService.get('DB_PORT', { infer: true }),
    username: configService.get('DB_USERNAME', { infer: true }),
    password: configService.get('DB_PASSWORD', { infer: true }),
    database: configService.get('DB_DATABASE', { infer: true }),

    migrations: [path.resolve(__dirname, '../', 'migrations', '*{.ts,.js}')],
    entities: [path.resolve(__dirname, '../', '**', '*.entity{.ts,.js}')],
    migrationsRun: configService.get('DB_RUN_MIGRATIONS', { infer: true }),
    synchronize: configService.get('DB_SYNCHRONIZE', { infer: true }),
    logging: configService.get('DB_LOGGING', { infer: true }),
  };

  const disableSslRaw = configService.get('DB_DISABLE_SSL_AUTH');
  const disableSsl =
    typeof disableSslRaw === 'boolean'
      ? disableSslRaw
      : disableSslRaw === 'true';

  if (disableSsl) {
    // @ts-expect-error Irrelevant.
    config.ssl = {
      rejectUnauthorized: false,
    };
  }

  return config;
};

/**
 * Creates and initializes a transactional TypeORM data source from the provided options.
 * Initializes the transactional context required by typeorm-transactional.
 */
export const getDataSource = (options?: DataSourceOptions) => {
  if (!options) {
    throw new Error('No DataSourceOptions passed');
  }

  initializeTransactionalContext();

  return Promise.resolve(addTransactionalDataSource(new DataSource(options)));
};
