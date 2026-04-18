import { ConfigModule } from '@nestjs/config';
import { z } from 'zod';

/**
 * A Zod preprocessed schema that validates and converts incoming values into a boolean.
 */
const booleanValidator = z.preprocess((val) => {
  if (!val || typeof val !== 'string' || !['true', 'false'].includes(val)) {
    return undefined;
  }

  return val === 'true';
}, z.boolean());

/**
 * Schema definition for environment variables using Zod.
 * Validates and enforces the structure of environment variables required by the application.
 */
export const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']),
  PORT: z.coerce.number(),

  // Database configuration
  DB_HOST: z.string(),
  DB_PORT: z.coerce.number(),
  DB_USERNAME: z.string(),
  DB_PASSWORD: z.string(),
  DB_DATABASE: z.string(),
  DB_SYNCHRONIZE: booleanValidator,
  DB_RUN_MIGRATIONS: booleanValidator,
  DB_LOGGING: booleanValidator,
  DB_DISABLE_SSL_AUTH: booleanValidator,
});

export type EnvironmentVariables = z.infer<typeof environmentSchema>;

/**
 * Validates the provided configuration object against the environment schema.
 * If validation fails, an error is thrown detailing the issues.
 */
export const validateEnvs = (config: Record<string, unknown>) => {
  const result = environmentSchema.safeParse(config);

  if (!result.success) {
    throw new Error(
      `Environment validation failed: ${result.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join(', ')}`,
    );
  }

  return result.data;
};

/**
 * Factory that returns a configured ConfigModule for the NestJS app.
 * Registers environment files and wires the Zod validator.
 */
export const getConfigModule = () =>
  ConfigModule.forRoot({
    isGlobal: true,
    validate: validateEnvs,
    envFilePath: ['.env.local', '.env'],
  });
