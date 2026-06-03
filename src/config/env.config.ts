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

  // Auth configuration
  JWT_SECRET: z.string().min(32),
  JWT_EXPIRES_IN: z.string().default('30d'),
  APPLE_CLIENT_ID: z.string(),

  // Redis configuration (first consumed by the assistant: BullMQ webhook queue,
  // dedupe set, link nonces, held-conflict writes).
  REDIS_HOST: z.string().default('127.0.0.1'),
  REDIS_PORT: z.coerce.number().default(6379),
  REDIS_PASSWORD: z.string().optional(),
  REDIS_DB: z.coerce.number().int().min(0).default(0),

  // External messaging vendor (Telegram) — read by the external-vendor connector.
  EXTERNAL_VENDOR: z.enum(['telegram']).default('telegram'),
  TELEGRAM_BOT_TOKEN: z.string(),
  TELEGRAM_WEBHOOK_SECRET: z.string(),
  TELEGRAM_API_BASE: z.string().default('https://api.telegram.org'),

  // AI provider (Anthropic) — read by the AI connector.
  ASSISTANT_AI_PROVIDER: z.enum(['anthropic']).default('anthropic'),
  ANTHROPIC_API_KEY: z.string(),
  ASSISTANT_MODEL_MAIN: z.string(),
  ASSISTANT_MODEL_BACKGROUND: z.string(),
  ASSISTANT_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(1024),
  ASSISTANT_AI_MAX_RETRIES: z.coerce.number().int().min(0).default(2),

  // Speech-to-text (OpenAI) — read by the STT connector.
  STT_PROVIDER: z.enum(['openai']).default('openai'),
  OPENAI_API_KEY: z.string(),
  STT_MODEL: z.string().default('gpt-4o-mini-transcribe'),
  STT_TRANSLATE_TO_ENGLISH: booleanValidator.default(false),

  // Assistant orchestration knobs.
  // Public HTTPS base for registerWebhook; webhook registration is skipped when unset.
  ASSISTANT_WEBHOOK_URL: z.string().optional(),
  // Public HTTPS base for the iOS universal link in the linking prompt; the
  // prompt falls back to raw-code-only when unset.
  ASSISTANT_APP_LINK_BASE_URL: z.string().optional(),
  ASSISTANT_MAX_TOOL_ROUNDTRIPS: z.coerce.number().int().positive().default(8),
  ASSISTANT_MAX_SCHEDULE_FETCHES: z.coerce.number().int().positive().default(5),
  ASSISTANT_HELD_CONFLICT_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(600),
  ASSISTANT_LINK_NONCE_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(600),
  ASSISTANT_DEDUPE_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(3600),
  ASSISTANT_RECENT_WINDOW_SIZE: z.coerce.number().int().positive().default(10),
  ASSISTANT_PRELOAD_HORIZON_DAYS: z.coerce.number().int().positive().default(7),
  ASSISTANT_SUMMARIZE_THRESHOLD: z.coerce.number().int().positive().default(20),
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
